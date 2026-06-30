import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvalContext,
  approvalPayloadSummary,
  sanitizeForDisplay,
  withApprovalLinks
} from "../src/approvalPresentation.js";

const runs = new Map([
  ["run 1", {
    id: "run 1",
    status: "waiting_approval",
    capabilitySlug: "improve",
    capabilityName: "Improve",
    workflowVersion: "2",
    currentStep: "approval",
    input: { prompt: "ship it" }
  }]
]);

const deps = {
  getRun: (id) => runs.get(id),
  getCapability: (slug) => ({ slug, name: slug === "improve" ? "Improve" : slug, version: "1" }),
  deriveRunTitle: (run) => `Title for ${run.id}`,
  deriveRunDescription: (run) => `Description for ${run.id}`
};

describe("approval presentation helpers", () => {
  it("sanitizes nested display data and redacts secret-looking keys", () => {
    const value = sanitizeForDisplay({
      apiKey: "secret",
      visible: "x".repeat(600),
      nested: { password: "hidden", ok: true, deeper: { value: { tooDeep: "yes" } } },
      items: Array.from({ length: 14 }, (_, index) => index)
    });

    assert.equal(value.apiKey, "[redacted]");
    assert.equal(value.visible.length, 500);
    assert.equal(value.nested.password, "[redacted]");
    assert.equal(value.nested.deeper.value, "[nested value]");
    assert.equal(value.items.length, 13);
    assert.equal(value.items.at(-1), "... 2 more");
  });

  it("summarizes approval payloads without leaking secrets", () => {
    assert.deepEqual(
      approvalPayloadSummary({
        payload: {
          capability: "improve",
          input: { prompt: "fix", token: "abc" },
          privateKey: "key",
          note: "ok"
        }
      }),
      {
        capability: "improve",
        input: { prompt: "fix", token: "[redacted]" },
        privateKey: "[redacted]",
        note: "ok"
      }
    );
  });

  it("builds approval context from payload, run, and capability data", () => {
    const approval = {
      id: "appr 1",
      runId: "run 1",
      status: "pending",
      requestedBy: "fallback",
      payload: {
        capability: "improve",
        origin: { via: "mcp", name: "operator" },
        input: {
          project: "Runyard",
          repo: "runyard",
          path: "src",
          targetBranch: "main",
          deploy: true,
          change: "Refactor approval presentation"
        }
      }
    };

    const context = approvalContext(approval, deps);
    assert.equal(context.requestedBy, "mcp: operator");
    assert.equal(context.workflow.deepLink, "/app#workflows/improve");
    assert.equal(context.project.display, "Runyard / runyard / src");
    assert.equal(context.targetBranch, "main");
    assert.equal(context.deploy, true);
    assert.equal(context.run.deepLink, "/app#runs/run%201");
    assert.equal(context.proposedChange, "Refactor approval presentation");
    assert.equal(context.proposedAction, "Queue Improve for runner execution, with deploy enabled, targeting main.");
  });

  it("decorates approvals with links, context, and payload summaries", () => {
    const decorated = withApprovalLinks({
      id: "appr 1",
      runId: "run 1",
      status: "pending",
      payload: { capability: "improve", input: { prompt: "fix" } }
    }, deps);

    assert.equal(decorated.deepLink, "/app#approvals/appr%201");
    assert.equal(decorated.deepLinkRun, "/app#runs/run%201");
    assert.equal(decorated.context.run.title, "Title for run 1");
    assert.deepEqual(decorated.payloadSummary.input, { prompt: "fix" });
  });
});
