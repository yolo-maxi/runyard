import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capConfidence,
  fallbackSeverity,
  fallbackSummary,
  normalizeAnalysis,
  normalizeEvidenceInferenceEntry,
  normalizeStringList,
  parseJsonObject
} from "../src/runObstructionAnalysisNormalization.js";

const redactText = (value, max = 500) => String(value || "").slice(0, max);

function payload(overrides = {}) {
  return {
    run: { status: "succeeded" },
    evidence: {
      quality: "thin",
      detectedSignals: {
        warningEvents: 1,
        retrySignals: 0,
        fallbackSignals: 0,
        longTimingSignals: [],
        successfulButPainful: true
      }
    },
    ...overrides
  };
}

describe("run obstruction analysis normalization", () => {
  it("parses direct, fenced, embedded, and malformed JSON objects", () => {
    assert.deepEqual(parseJsonObject({ ok: true }), { ok: true });
    assert.deepEqual(parseJsonObject("```json\n{\"ok\":true}\n```"), { ok: true });
    assert.deepEqual(parseJsonObject("prefix {\"ok\":true} suffix"), { ok: true });
    assert.deepEqual(parseJsonObject("not json"), {});
  });

  it("caps confidence by evidence quality", () => {
    assert.equal(capConfidence("high", "rich"), "high");
    assert.equal(capConfidence("high", "moderate"), "medium");
    assert.equal(capConfidence("high", "thin"), "low");
    assert.equal(capConfidence("unknown", "moderate"), "medium");
  });

  it("normalizes evidence/inference entries and recommendation lists", () => {
    assert.deepEqual(normalizeEvidenceInferenceEntry("plain inference", payload(), { redactText }), {
      evidence: "",
      inference: "plain inference",
      severity: "low",
      confidence: "low"
    });
    assert.deepEqual(normalizeEvidenceInferenceEntry({
      category: "tooling",
      evidence: "stderr",
      impact: "slow",
      severity: "HIGH",
      confidence: "HIGH"
    }, payload({ evidence: { quality: "moderate", detectedSignals: {} } }), { redactText }), {
      category: "tooling",
      evidence: "stderr",
      inference: "slow",
      impact: "slow",
      severity: "high",
      confidence: "medium"
    });
    assert.deepEqual(normalizeStringList([{ proposal: "a" }, { text: "b" }, { summary: "c" }, { nope: true }], { redactText }), ["a", "b", "c"]);
  });

  it("builds fallback severity, summaries, and normalized analysis", () => {
    assert.equal(fallbackSeverity(payload({ run: { status: "failed" } })), "high");
    assert.match(fallbackSummary(payload({ run: { status: "failed" } })), /Terminal failed/);
    const normalized = normalizeAnalysis({
      severity: "medium",
      confidence: "high",
      summary: "friction",
      suggestedWorkflowImprovements: ["summarize retries"]
    }, payload(), { redactText });

    assert.equal(normalized.confidence, "low");
    assert.equal(normalized.doNotAutoMutate, true);
    assert.deepEqual(normalized.suggestedWorkflowImprovements, ["summarize retries"]);
    assert.equal(normalized.observations.length, 1, "fallback observation should be added for non-none severity");
  });
});
