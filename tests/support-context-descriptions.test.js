import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSupportContextDescribers } from "../src/supportContextDescriptions.js";

function harness(overrides = {}) {
  const describers = createSupportContextDescribers({
    dashboardStats: () => ({ runs: 9, runningRuns: 2, pendingApprovals: 1 }),
    getApproval: (id) => overrides.approvals?.[id] || null,
    getCapability: (slug) => overrides.capabilities?.[slug] || null,
    listApprovals: () => overrides.pendingApprovals || [],
    listCapabilities: () => overrides.capabilitiesList || [],
    listRunEvents: () => overrides.events || [],
    listRuns: (query) => overrides.listRuns?.(query) || [],
    runnerPoolStats: () => ({
      runners: 3,
      onlineRunners: 2,
      totalActive: 1,
      totalCapacity: 4,
      availableSlots: 3,
      queued: 5,
      running: 1,
      waitingApproval: 1
    })
  });
  return describers;
}

describe("support context descriptions", () => {
  it("describes runs with safe inputs and focused events", () => {
    const describers = harness({
      events: [
        { type: "runner.heartbeat", message: "tick" },
        { type: "node.failed", message: "Build failed with token shub_abcdefghijklmnop" }
      ]
    });

    const text = describers.describeRun({
      id: "run_1",
      capabilitySlug: "hello",
      status: "failed",
      currentStep: "build",
      error: "TypeError",
      input: {
        goal: "Ship widget",
        apiKey: "sk-secret",
        nested: { skip: true }
      }
    });

    assert.match(text, /Run run_1 — hello/);
    assert.match(text, /Status: failed/);
    assert.match(text, /Input: goal=Ship widget/);
    assert.doesNotMatch(text, /apiKey/);
    assert.doesNotMatch(text, /runner\.heartbeat/);
    assert.match(text, /node\.failed/);
    assert.match(text, /\[redacted\]/);
  });

  it("describes overview, workflow, approvals, and runner pool views", () => {
    const describers = harness({
      capabilities: {
        hello: { slug: "hello", name: "Hello", category: "demo", description: "Says hello" }
      },
      approvals: {
        appr_1: { id: "appr_1", status: "pending", title: "Approve", runId: "run_1", comment: "Looks ok" }
      },
      pendingApprovals: [{ id: "appr_1", title: "Approve" }],
      capabilitiesList: [{ slug: "hello", category: "demo", description: "Says hello" }],
      listRuns: (query) => query.status === "failed"
        ? [{ id: "run_failed", capabilitySlug: "hello", error: "bad" }]
        : [{ id: "run_recent", capabilitySlug: "hello", status: "succeeded" }]
    });

    assert.match(describers.describeRunsList(), /Runs overview/);
    assert.match(describers.describeRunsList(), /run_failed/);
    assert.match(describers.describeWorkflow("hello"), /Workflow Hello/);
    assert.match(describers.describeWorkflowsList(), /Workflows catalog/);
    assert.match(describers.describeApprovals(["approvals", "appr_1"]), /Approval appr_1/);
    assert.match(describers.describeApprovals(["approvals"]), /Pending approvals/);
    assert.match(describers.describeRunners(), /Runner pool/);
  });
});
