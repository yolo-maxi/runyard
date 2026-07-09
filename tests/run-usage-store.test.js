import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { createRunUsageStore } from "../src/runUsageStore.js";
import { createRunMutationStore } from "../src/runMutationStore.js";
import { createRunBudgetEnforcer } from "../src/runBudget.js";
import { normalizeRun, runEventListQuery, normalizeRunEvent } from "../src/runRecords.js";

function harness({ budget = null } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(DB_SCHEMA_SQL);
  let sequence = 0;
  let tick = 0;
  const now = () => `2026-07-08T00:00:${String(tick++).padStart(2, "0")}.000Z`;
  const all = (sql, params) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params));
  const one = (sql, params) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params));
  const run = (sql, params) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params));

  run("INSERT INTO capabilities (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    "cap_1", "hello", "Hello", now(), now()
  ]);
  run(
    `INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version, status,
       current_step, input, budget, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["run_1", "cap_1", "hello", "Hello", 1, "running", "running", "{}", budget ? JSON.stringify(budget) : null, now(), now()]
  );

  const getRun = (runId) => normalizeRun(one("SELECT * FROM runs WHERE id = ?", [runId]));
  const mutation = createRunMutationStore({ one, run, now, getRun, adjustRunnerActiveRuns: () => {} });
  const events = [];
  const addRunEvent = (runId, type, message, data = {}) => {
    const event = { id: `evt_${++sequence}`, run_id: runId, type, message, data: JSON.stringify(data), created_at: now() };
    run("INSERT INTO run_events (id, run_id, type, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      event.id, event.run_id, event.type, event.message, event.data, event.created_at
    ]);
    events.push(normalizeRunEvent(event));
    return events[events.length - 1];
  };

  const store = createRunUsageStore({
    all,
    one,
    run,
    id: (prefix) => `${prefix}_${++sequence}`,
    now,
    getRun,
    updateRun: mutation.updateRun,
    addRunEvent
  });

  const terminalArtifactRuns = [];
  const enforcer = createRunBudgetEnforcer({
    getRun,
    addRunEvent,
    transitionRun: mutation.transitionRun,
    recordRunTerminalArtifacts: (runId) => terminalArtifactRuns.push(runId),
    now
  });

  const listEvents = (runId) => {
    const query = runEventListQuery(runId);
    return all(query.sql, query.params).map(normalizeRunEvent);
  };

  return { store, enforcer, getRun, events, listEvents, terminalArtifactRuns };
}

describe("run usage store", () => {
  it("persists a record, updates the run aggregate, and emits run.usage in one call", () => {
    const { store, getRun, events } = harness();
    const result = store.recordRunUsage("run_1", {
      provider: "anthropic",
      model: "claude-opus-4-7",
      promptTokens: 6,
      completionTokens: 1744,
      source: "runner",
      nodeId: "factory",
      requestId: "run-abc:18"
    });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.usage.totalTokens, 1750);
    assert.equal(result.usage.calls, 1);

    // Aggregate persisted on the run row.
    const runRow = getRun("run_1");
    assert.equal(runRow.usage.totalTokens, 1750);
    assert.equal(runRow.usage.byModel["claude-opus-4-7"].completionTokens, 1744);

    // Event emitted in the same call, carrying record + running totals.
    const usageEvents = events.filter((event) => event.type === "run.usage");
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0].data.totals.totalTokens, 1750);
    assert.equal(usageEvents[0].data.record.model, "claude-opus-4-7");

    // Cost estimated from the price table for a known model, flagged as such.
    assert.equal(result.record.costMicros, 6 * 15 + 1744 * 75);
    assert.equal(result.record.metadata.costSource, "price-table");
    assert.equal(runRow.usage.costMicros, result.record.costMicros);
  });

  it("deduplicates replayed reports by requestId without double counting", () => {
    const { store, getRun } = harness();
    const body = { model: "m", promptTokens: 10, completionTokens: 1, source: "runner", requestId: "sid:1" };
    assert.equal(store.recordRunUsage("run_1", body).duplicate, false);
    const replay = store.recordRunUsage("run_1", body);
    assert.equal(replay.ok, true);
    assert.equal(replay.duplicate, true);
    assert.equal(getRun("run_1").usage.calls, 1);
    assert.equal(store.getRunUsage("run_1").records.length, 1);
  });

  it("rejects unknown runs and invalid bodies", () => {
    const { store } = harness();
    assert.equal(store.recordRunUsage("run_missing", { promptTokens: 1 }).code, 404);
    const invalid = store.recordRunUsage("run_1", { promptTokens: -2 });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 400);
  });

  it("keeps provider-reported cost and infers missing provider labels", () => {
    const { store } = harness();
    const result = store.recordRunUsage("run_1", {
      model: "claude-sonnet-5",
      promptTokens: 100,
      completionTokens: 10,
      costMicros: 777,
      source: "gateway"
    });
    assert.equal(result.record.costMicros, 777);
    assert.equal(result.record.metadata.costSource, "provider");
    assert.equal(result.record.provider, "anthropic");
  });

  it("getRunUsage returns aggregate, budget, and ordered records", () => {
    const { store } = harness({ budget: { maxTokens: 100000 } });
    store.recordRunUsage("run_1", { model: "a", promptTokens: 1, completionTokens: 1, source: "api" });
    store.recordRunUsage("run_1", { model: "b", promptTokens: 2, completionTokens: 2, source: "api" });
    const usage = store.getRunUsage("run_1");
    assert.equal(usage.records.length, 2);
    assert.deepEqual(usage.records.map((record) => record.model), ["a", "b"]);
    assert.equal(usage.usage.totalTokens, 6);
    assert.deepEqual(usage.budget, { maxTokens: 100000 });
    assert.equal(store.getRunUsage("run_missing"), null);
  });
});

describe("run budget enforcement", () => {
  it("does nothing while usage is under budget", () => {
    const { store, enforcer, getRun } = harness({ budget: { maxTokens: 1000 } });
    store.recordRunUsage("run_1", { model: "m", promptTokens: 10, completionTokens: 10, source: "runner" });
    const outcome = enforcer.enforceRunBudget("run_1");
    assert.equal(outcome.exceeded, false);
    assert.equal(getRun("run_1").status, "running");
  });

  it("hard-stops the run with budget_exceeded status, event, and terminal artifacts", () => {
    const { store, enforcer, getRun, listEvents, terminalArtifactRuns } = harness({ budget: { maxTokens: 100 } });
    store.recordRunUsage("run_1", { model: "m", promptTokens: 90, completionTokens: 20, source: "runner" });
    const outcome = enforcer.enforceRunBudget("run_1");
    assert.equal(outcome.exceeded, true);
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.dimension, "tokens");

    const runRow = getRun("run_1");
    assert.equal(runRow.status, "budget_exceeded");
    assert.match(runRow.error, /budget exceeded: 110 tokens used, budget\.maxTokens is 100/);
    assert.ok(runRow.completedAt);

    const eventTypes = listEvents("run_1").map((event) => event.type);
    assert.ok(eventTypes.includes("run.budget.exceeded"));
    assert.deepEqual(terminalArtifactRuns, ["run_1"]);
  });

  it("stops on cost ceilings using estimated cost", () => {
    const { store, enforcer, getRun } = harness({ budget: { maxCostMicros: 1000 } });
    // claude-opus-4-7: 100 prompt + 20 completion = 100*15 + 20*75 = 3000 micros.
    store.recordRunUsage("run_1", { model: "claude-opus-4-7", promptTokens: 100, completionTokens: 20, source: "runner" });
    const outcome = enforcer.enforceRunBudget("run_1");
    assert.equal(outcome.exceeded, true);
    assert.equal(outcome.dimension, "cost");
    assert.equal(getRun("run_1").status, "budget_exceeded");
  });

  it("is idempotent once the run is terminal — no repeat events", () => {
    const { store, enforcer, listEvents } = harness({ budget: { maxTokens: 10 } });
    store.recordRunUsage("run_1", { model: "m", promptTokens: 50, completionTokens: 0, source: "runner" });
    assert.equal(enforcer.enforceRunBudget("run_1").stopped, true);
    const again = enforcer.enforceRunBudget("run_1");
    assert.equal(again.exceeded, true);
    assert.equal(again.stopped, false);
    assert.equal(again.alreadyTerminal, true);
    const breaches = listEvents("run_1").filter((event) => event.type === "run.budget.exceeded");
    assert.equal(breaches.length, 1);
  });

  it("ignores runs without a budget", () => {
    const { store, enforcer } = harness();
    store.recordRunUsage("run_1", { model: "m", promptTokens: 1e6, completionTokens: 0, source: "runner" });
    assert.equal(enforcer.enforceRunBudget("run_1").exceeded, false);
  });
});
