import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeDetectedSignals,
  evidenceQuality,
  highlightEvents,
  summarizeDiagnostics,
  timingSignals,
  topEventTypes
} from "../src/runObstructionSignals.js";

function redactText(value, max = 400) {
  return String(value || "").slice(0, max).replace(/secret/gi, "[redacted]");
}

describe("run obstruction signal helpers", () => {
  it("summarizes diagnostics with bounded redacted fields", () => {
    const summary = summarizeDiagnostics(
      {
        status: "failed",
        headline: `secret ${"x".repeat(300)}`,
        reason: "token secret leaked",
        failedStep: "deploy secret",
        failureType: "tool_error",
        approval: {
          status: "resolved",
          decision: "denied",
          title: "Needs secret",
          comment: "No secret",
          requestedBy: "secret-user"
        },
        timeline: Array.from({ length: 14 }, (_, i) => ({ type: "event", message: `secret timeline ${i}` })),
        logExcerpts: Array.from({ length: 9 }, (_, i) => ({ type: "stderr", message: `secret log ${i}` }))
      },
      { redactText }
    );

    assert.equal(summary.headline.includes("[redacted]"), true);
    assert.ok(summary.headline.length < 300);
    assert.equal(summary.approval.requestedBy, "[redacted]-user");
    assert.equal(summary.timeline.length, 12);
    assert.equal(summary.logExcerpts.length, 8);
    assert.equal(summary.timeline[0].message, "[redacted] timeline 2");
  });

  it("redacts event summaries while preserving counts", () => {
    const logSummary = {
      types: [{ key: "stderr-secret", count: "3", category: "secret-cat" }],
      highlights: [{ type: "stderr", category: "log", severity: "warn", node: "secret-node", message: "retry secret" }]
    };

    assert.deepEqual(topEventTypes(logSummary, { redactText }), [
      { key: "stderr-[redacted]", count: 3, category: "[redacted]-cat" }
    ]);
    assert.equal(highlightEvents(logSummary, { redactText })[0].message, "retry [redacted]");
  });

  it("detects timing, retry, fallback, approval, and output gap signals", () => {
    const timing = { queuedMs: 6 * 60_000, executionMs: 21 * 60_000, totalMs: 31 * 60_000 };
    const signals = computeDetectedSignals({
      run: { status: "succeeded" },
      timing,
      logSummary: {
        totals: { events: 30, errors: 0, warnings: 1 },
        categories: [{ key: "approval", count: 2 }]
      },
      highlights: [
        { type: "stderr", message: "retrying after failure" },
        { type: "log", message: "used manual workaround" }
      ],
      inventory: [],
      diagnostics: { failedStep: "build" },
      outputShape: { type: "null" }
    });

    assert.deepEqual(timingSignals(timing), ["queued_over_5m", "execution_over_20m", "total_over_30m"]);
    assert.equal(signals.retrySignals, 1);
    assert.equal(signals.fallbackSignals, 1);
    assert.equal(signals.approvalEvents, 2);
    assert.equal(signals.artifactOutputGaps.noWorkflowArtifacts, true);
    assert.equal(signals.successfulButPainful, true);
    assert.equal(evidenceQuality(signals, { totals: { events: 30 } }), "rich");
  });

  it("returns no evidence quality for non-terminal runs", () => {
    const signals = computeDetectedSignals({
      run: { status: "running" },
      timing: {},
      logSummary: { totals: { errors: 5 } },
      highlights: [],
      inventory: [],
      diagnostics: null,
      outputShape: { type: "object" }
    });

    assert.equal(signals.terminalStatus, false);
    assert.equal(evidenceQuality(signals), "none");
  });
});
