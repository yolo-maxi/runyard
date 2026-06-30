import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diagnosticArtifactScore,
  diagnosticArtifacts,
  failureStep,
  findFailureEvent,
  quickFailedStep,
  quickReasonHint,
  relevantApproval,
  runDiagnostics
} from "../src/runDiagnostics.js";

describe("run diagnostics helpers", () => {
  it("finds failure events and falls back to current step", () => {
    const events = [
      { id: "1", type: "workflow.step", message: "build", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", type: "node.failed", message: "boom", data: { node: "test" }, createdAt: "2026-01-01T00:00:01.000Z" }
    ];
    const failure = findFailureEvent(events);
    assert.equal(failure.id, "2");
    assert.equal(failureStep({ currentStep: "fallback" }, events, failure), "test");
    assert.equal(failureStep({}, events, null), "build");
  });

  it("scores and selects diagnostic artifacts", () => {
    const selected = diagnosticArtifacts(
      [
        { id: "img", name: "screenshot.png", mimeType: "image/png", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "stderr", name: "stderr.log", mimeType: "text/x-log", createdAt: "2026-01-01T00:00:01.000Z" },
        { id: "trace", name: "trace.txt", mimeType: "text/plain", createdAt: "2026-01-01T00:00:02.000Z" }
      ],
      { withArtifactLinks: (artifact) => ({ ...artifact, linked: true }) }
    );

    assert.equal(diagnosticArtifactScore({ name: "stderr.log", mimeType: "text/x-log" }) > 0, true);
    assert.deepEqual(selected.map((artifact) => artifact.id), ["stderr", "trace"]);
    assert.equal(selected[0].linked, true);
  });

  it("prefers pending and actionable approvals for diagnostics", () => {
    const approvals = [
      { id: "old", runId: "run_1", status: "approved" },
      { id: "changes", runId: "run_1", status: "resolved", decision: "changes_requested" },
      { id: "pending", runId: "run_1", status: "pending" }
    ];
    assert.equal(relevantApproval("run_1", { listApprovals: () => approvals }).id, "pending");
    assert.equal(relevantApproval("missing", { listApprovals: () => approvals }), null);
  });

  it("builds structured diagnostics with redacted timeline and logs", () => {
    const events = [
      {
        id: "step",
        type: "workflow.step",
        message: "build",
        data: { token: "secret", ok: true },
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "stderr",
        type: "stderr",
        message: "failed with token=abc123",
        createdAt: "2026-01-01T00:00:01.000Z"
      },
      {
        id: "failed",
        type: "run.failed",
        message: "run failed token=abc123",
        data: { step: "test" },
        createdAt: "2026-01-01T00:00:02.000Z"
      }
    ];
    const diagnostics = runDiagnostics(
      {
        id: "run_1",
        status: "failed",
        error: "",
        currentStep: "test",
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:03.000Z"
      },
      events,
      [{ id: "artifact", name: "stderr.log", mimeType: "text/x-log", createdAt: "2026-01-01T00:00:03.000Z" }],
      {
        listApprovals: () => [{ id: "appr_1", runId: "run_1", status: "pending", title: "Approve" }],
        sanitizeForDisplay: (value) => ({ ...value, token: "[redacted]" }),
        withArtifactLinks: (artifact) => ({ ...artifact, deepLink: `/artifact/${artifact.id}` })
      }
    );

    assert.equal(diagnostics.status, "failed");
    assert.equal(diagnostics.failedStep, "test");
    assert.equal(diagnostics.approval.deepLink, "/app#approvals/appr_1");
    assert.equal(diagnostics.timeline[0].data.token, "[redacted]");
    assert.match(diagnostics.logExcerpts.find((event) => event.type === "stderr").message, /\[redacted\]/);
    assert.equal(diagnostics.artifacts[0].deepLink, "/artifact/artifact");
  });

  it("keeps cheap run-list hints query-free", () => {
    assert.equal(quickReasonHint({ status: "failed", error: "x".repeat(200) }).length, 140);
    assert.equal(quickFailedStep({ status: "waiting_approval", currentStep: "approve" }), "approve");
    assert.equal(quickReasonHint({ status: "succeeded" }), "");
  });
});
