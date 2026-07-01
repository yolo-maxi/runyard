import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServerPresentation } from "../src/serverPresentation.js";

function presentation(overrides = {}) {
  const capabilities = {
    hello: {
      slug: "hello",
      name: "Hello Workflow",
      description: "Demo workflow"
    }
  };
  return createServerPresentation({
    getCapability: (slug) => capabilities[slug] || null,
    getRun: (id) => id === "run_1"
      ? { id, status: "waiting_approval", capabilitySlug: "hello", input: { goal: "Ship it" } }
      : null,
    listApprovals: () => [{ id: "appr_1", runId: "run_failed", status: "pending", title: "Need approval" }],
    listRuns: () => [
      { id: "run_queued_1", status: "queued", createdAt: "2026-06-30T00:00:00.000Z" },
      { id: "run_queued_2", status: "queued", createdAt: "2026-06-30T00:01:00.000Z" }
    ],
    sanitizeForDisplay: (value) => ({ ...value, sanitized: true }),
    withArtifactLinks: (artifact) => ({ ...artifact, linked: true }),
    ...overrides
  });
}

describe("server presentation factory", () => {
  it("decorates queued single runs with live queue position", () => {
    const presenters = presentation();

    const decorated = presenters.decorateSingleRun({
      id: "run_queued_2",
      status: "queued",
      capabilitySlug: "hello",
      createdAt: "2026-06-30T00:01:00.000Z"
    });

    assert.equal(decorated.queue.position, 2);
    assert.equal(decorated.queue.total, 2);
    assert.equal(decorated.deepLink, "/app#runs/run_queued_2");
    assert.equal(decorated.deepLinkWorkflow, "/app#workflows/hello");
  });

  it("passes through null and decorates non-queued single runs without queue metadata", () => {
    const presenters = presentation();

    assert.equal(presenters.decorateSingleRun(null), null);
    const decorated = presenters.decorateSingleRun({
      id: "run_done",
      status: "succeeded",
      capabilitySlug: "hello"
    });

    assert.equal(decorated.queue, undefined);
    assert.equal(decorated.deepLinkLogs, "/app#runs/run_done/logs");
  });

  it("decorates approvals with links and contextual run data", () => {
    const decorated = presentation().withApprovalLinks({
      id: "appr_1",
      runId: "run_1",
      status: "pending",
      payload: { capability: "hello", input: { requestedBy: "operator" } }
    });

    assert.equal(decorated.deepLink, "/app#approvals/appr_1");
    assert.equal(decorated.deepLinkRun, "/app#runs/run_1");
    assert.equal(decorated.context.workflow.slug, "hello");
    assert.equal(decorated.context.run.id, "run_1");
  });

  it("builds run diagnostics with approval and artifact decorators wired in", () => {
    const diagnostics = presentation().runDiagnostics(
      {
        id: "run_failed",
        status: "failed",
        currentStep: "deploy",
        error: "provider token=secret failed"
      },
      [
        {
          id: "event_1",
          type: "run.failed",
          message: "provider failed",
          createdAt: "2026-06-30T00:01:00.000Z",
          data: { token: "secret" }
        }
      ],
      [
        {
          id: "artifact_1",
          runId: "run_failed",
          name: "stderr.log",
          mimeType: "text/x-log",
          createdAt: "2026-06-30T00:01:00.000Z"
        }
      ]
    );

    assert.equal(diagnostics.status, "failed");
    assert.equal(diagnostics.approval.id, "appr_1");
    assert.equal(diagnostics.artifacts[0].linked, true);
  });
});
