import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRunObstructionAnalysisPayload,
  hasEnoughEvidenceForObstructionAnalysis,
  payloadForBudget,
  redactAnalysisText,
  RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION
} from "../src/runObstructionPayload.js";

function terminalRun(overrides = {}) {
  return {
    id: "run_payload",
    status: "succeeded",
    capabilitySlug: "hello",
    capabilityName: "Hello",
    currentStep: "retry token=shub_secret_value",
    input: { prompt: "secret prompt" },
    output: { ok: true },
    createdAt: "2026-06-19T00:00:00.000Z",
    assignedAt: "2026-06-19T00:01:00.000Z",
    startedAt: "2026-06-19T00:02:00.000Z",
    completedAt: "2026-06-19T00:35:00.000Z",
    ...overrides
  };
}

describe("run obstruction payload helpers", () => {
  it("builds redacted bounded evidence with detected signals", () => {
    const payload = buildRunObstructionAnalysisPayload({
      generatedAt: "2026-06-19T01:00:00.000Z",
      run: terminalRun(),
      capability: {
        slug: "hello",
        name: "Hello",
        workflow: { engine: "smithers", entry: ".smithers/workflows/hello.tsx?token=shub_secret" },
        requiredRunnerTags: ["smithers"],
        requiredSkills: ["research"],
        requiredAgents: ["agent"]
      },
      artifacts: [{ id: "a1", name: "result.md", mimeType: "text/markdown", metadata: { token: "ghp_abcdefghijklmnopqrstuvwxyz" } }],
      logSummary: {
        totals: { events: 30, highlights: 2, errors: 0, warnings: 1 },
        categories: [{ key: "log", count: 20 }],
        severities: [{ key: "warn", count: 1 }],
        types: [{ key: "stderr", count: 1, category: "log" }],
        highlights: [{ type: "stderr", category: "log", severity: "warn", message: "retry with sk-abcdefghijklmnopqrstuvwxyz" }]
      }
    });

    assert.equal(payload.schemaVersion, RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION);
    assert.equal(payload.evidence.quality, "moderate");
    assert.equal(payload.evidence.detectedSignals.retrySignals, 1);
    assert.equal(payload.evidence.detectedSignals.successfulButPainful, true);
    assert.equal(hasEnoughEvidenceForObstructionAnalysis(payload), true);
    assert.doesNotMatch(JSON.stringify(payload), /shub_secret_value|sk-abcdefghijklmnopqrstuvwxyz|ghp_abcdefghijklmnopqrstuvwxyz/);
  });

  it("does not request analysis for clean successful runs", () => {
    const payload = buildRunObstructionAnalysisPayload({
      run: terminalRun({ completedAt: "2026-06-19T00:03:00.000Z" }),
      logSummary: { totals: { events: 1, highlights: 0, errors: 0, warnings: 0 } }
    });
    assert.equal(payload.evidence.quality, "thin");
    assert.equal(hasEnoughEvidenceForObstructionAnalysis(payload), false);
  });

  it("shrinks prompt payloads against a character budget", () => {
    const payload = buildRunObstructionAnalysisPayload({
      run: terminalRun({ status: "failed", error: "boom" }),
      logSummary: {
        totals: { events: 200, highlights: 100, errors: 20, warnings: 10 },
        highlights: Array.from({ length: 40 }, (_, i) => ({ type: "stderr", message: `error ${i}` }))
      }
    });
    const budgeted = payloadForBudget(payload, 500);
    assert.equal(budgeted.truncated, true);
    assert.ok(budgeted.json.length > 0);
    assert.equal(budgeted.payload.truncation.reason.includes("Prompt payload exceeded budget"), true);
  });

  it("redacts and collapses analysis text", () => {
    assert.equal(redactAnalysisText("token=shub_secret\n\nnext", 200), "token=[redacted] next");
  });
});
