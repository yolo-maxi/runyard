import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyUsageToAggregate,
  emptyRunUsage,
  formatTokenCount,
  normalizeUsageInput,
  normalizeRunUsageRecord,
  runUsageRecordRow,
  usageEventMessage
} from "../src/runUsage.js";
import { estimateCostMicros, modelPrice, providerForModel } from "../src/modelPricing.js";
import { evaluateRunBudget, normalizeRunBudget, requestedRunBudget, runBudgetStop } from "../src/runBudget.js";

describe("normalizeUsageInput", () => {
  it("accepts a full record and derives totalTokens", () => {
    const result = normalizeUsageInput({
      provider: "anthropic",
      model: "claude-opus-4-7",
      promptTokens: 6,
      completionTokens: 1744,
      source: "runner",
      nodeId: "factory",
      requestId: "run-1:18",
      metadata: { iteration: 0 }
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.totalTokens, 1750);
    assert.equal(result.value.model, "claude-opus-4-7");
    assert.equal(result.value.nodeId, "factory");
    assert.equal(result.value.requestId, "run-1:18");
  });

  it("rejects garbage counts, zero-usage rows, and unknown sources", () => {
    assert.equal(normalizeUsageInput({ promptTokens: -1 }).ok, false);
    assert.equal(normalizeUsageInput({ promptTokens: "abc" }).ok, false);
    assert.equal(normalizeUsageInput({ promptTokens: 0, completionTokens: 0 }).ok, false);
    assert.equal(normalizeUsageInput({ promptTokens: 1, source: "stdout-scrape" }).ok, false);
    assert.equal(normalizeUsageInput(null).ok, false);
    assert.equal(normalizeUsageInput([]).ok, false);
  });

  it("accepts explicit totals and provider-reported cost", () => {
    const result = normalizeUsageInput({ totalTokens: 10, costMicros: 42, source: "gateway" });
    assert.equal(result.ok, true);
    assert.equal(result.value.totalTokens, 10);
    assert.equal(result.value.promptTokens, 0);
    assert.equal(result.value.costMicros, 42);
  });
});

describe("applyUsageToAggregate", () => {
  const record = (over = {}) => ({
    provider: "anthropic",
    model: "claude-opus-4-7",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costMicros: 5250,
    ...over
  });

  it("accumulates run totals, byModel, and byProvider together", () => {
    let usage = applyUsageToAggregate(null, record());
    usage = applyUsageToAggregate(usage, record({ model: "gpt-4o", provider: "openai", costMicros: null }));
    assert.equal(usage.totalTokens, 300);
    assert.equal(usage.promptTokens, 200);
    assert.equal(usage.completionTokens, 100);
    assert.equal(usage.calls, 2);
    // Null costMicros must not contribute (never fake cost).
    assert.equal(usage.costMicros, 5250);
    assert.equal(usage.byModel["claude-opus-4-7"].totalTokens, 150);
    assert.equal(usage.byModel["gpt-4o"].calls, 1);
    assert.equal(usage.byModel["gpt-4o"].costMicros, 0);
    assert.equal(usage.byProvider.anthropic.calls, 1);
    assert.equal(usage.byProvider.openai.totalTokens, 150);
  });

  it("is pure: the input aggregate is not mutated", () => {
    const base = emptyRunUsage();
    applyUsageToAggregate(base, record());
    assert.equal(base.totalTokens, 0);
    assert.deepEqual(base.byModel, {});
  });

  it("round-trips through the row shape", () => {
    const normalized = normalizeUsageInput({ promptTokens: 10, completionTokens: 5, model: "m", source: "api" });
    const row = runUsageRecordRow({ id: "usg_1", runId: "run_1", value: normalized.value, createdAt: "2026-07-08T00:00:00.000Z" });
    const back = normalizeRunUsageRecord(row);
    assert.equal(back.totalTokens, 15);
    assert.equal(back.runId, "run_1");
    assert.equal(back.costMicros, null);
    assert.equal(back.ts, "2026-07-08T00:00:00.000Z");
  });
});

describe("model pricing", () => {
  it("prices known models and returns null for unknown ones", () => {
    assert.ok(modelPrice("claude-opus-4-7"));
    assert.equal(modelPrice("totally-unknown-model"), null);
    // $15/MTok prompt + $75/MTok completion == 15 + 75 micros for 1+1 tokens.
    assert.equal(estimateCostMicros({ model: "claude-opus-4-7", promptTokens: 1, completionTokens: 1 }), 90);
    assert.equal(estimateCostMicros({ model: "mystery", promptTokens: 1000, completionTokens: 1000 }), null);
  });

  it("infers provider labels from model ids", () => {
    assert.equal(providerForModel("claude-sonnet-5"), "anthropic");
    assert.equal(providerForModel("gpt-4o-mini"), "openai");
    assert.equal(providerForModel("o3-mini"), "openai");
    assert.equal(providerForModel("llama-3.3-70b"), "");
  });
});

describe("run budgets", () => {
  it("normalizes valid budgets and rejects invalid ones with issues", () => {
    assert.deepEqual(normalizeRunBudget(undefined), { budget: null, issues: [] });
    assert.deepEqual(normalizeRunBudget({ maxTokens: 10000 }).budget, { maxTokens: 10000 });
    assert.deepEqual(normalizeRunBudget({ maxTokens: 10000.9, maxCostMicros: 2_000_000 }).budget, {
      maxTokens: 10000,
      maxCostMicros: 2_000_000
    });
    assert.equal(normalizeRunBudget({ maxTokens: 0 }).issues.length, 1);
    assert.equal(normalizeRunBudget({ maxTokens: -5 }).issues.length, 1);
    assert.equal(normalizeRunBudget({ maxTokens: "lots" }).issues.length, 1);
    assert.equal(normalizeRunBudget({ maxDollars: 5 }).issues.length, 1);
    assert.equal(normalizeRunBudget("cheap").issues.length, 1);
  });

  it("prefers the explicit option over input.budget", () => {
    assert.deepEqual(requestedRunBudget({ budget: { maxTokens: 1 } }, { budget: { maxTokens: 2 } }), { maxTokens: 2 });
    assert.deepEqual(requestedRunBudget({ budget: { maxTokens: 1 } }, {}), { maxTokens: 1 });
    assert.equal(requestedRunBudget({}, {}), undefined);
  });

  it("evaluates token and cost ceilings independently", () => {
    const budget = { maxTokens: 1000, maxCostMicros: 500_000 };
    assert.equal(evaluateRunBudget(budget, { totalTokens: 999, costMicros: 499_999 }).exceeded, false);
    const tokens = evaluateRunBudget(budget, { totalTokens: 1000, costMicros: 0 });
    assert.equal(tokens.exceeded, true);
    assert.equal(tokens.dimension, "tokens");
    assert.match(tokens.reason, /budget\.maxTokens is 1000/);
    const cost = evaluateRunBudget(budget, { totalTokens: 0, costMicros: 500_000 });
    assert.equal(cost.exceeded, true);
    assert.equal(cost.dimension, "cost");
    assert.equal(evaluateRunBudget(null, { totalTokens: 1e9 }).exceeded, false);
    assert.equal(evaluateRunBudget({}, { totalTokens: 1e9 }).exceeded, false);
  });

  it("presents budgetStop only for budget_exceeded runs", () => {
    assert.equal(runBudgetStop({ status: "failed", error: "x" }), null);
    const stop = runBudgetStop({ status: "budget_exceeded", error: "budget exceeded: 12 tokens", budget: { maxTokens: 10 } });
    assert.equal(stop.stopped, true);
    assert.match(stop.reason, /budget exceeded/);
    assert.deepEqual(stop.budget, { maxTokens: 10 });
  });
});

describe("usage formatting", () => {
  it("formats token counts and event messages", () => {
    assert.equal(formatTokenCount(950), "950");
    assert.equal(formatTokenCount(1500), "1.5k");
    assert.equal(formatTokenCount(2_500_000), "2.5M");
    const message = usageEventMessage({
      model: "claude-opus-4-7",
      totalTokens: 1750,
      promptTokens: 6,
      completionTokens: 1744,
      costMicros: 130890,
      nodeId: "factory"
    });
    assert.match(message, /claude-opus-4-7: 1.8k tokens/);
    assert.match(message, /~\$0.1309/);
    assert.match(message, /node factory/);
  });
});
