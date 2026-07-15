import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRunFlow, FLOW_NODE_STATES, unwrapEngineEvent } from "../src/runFlow.js";

const graph = {
  name: "Ship Feature",
  nodes: [
    { id: "workflow", type: "entry", kind: "entry", label: "Ship Feature" },
    { id: "plan", type: "task", kind: "task", label: "plan" },
    { id: "implement", type: "task", kind: "task", label: "implement" },
    { id: "verify", type: "task", kind: "test", label: "verify" }
  ],
  edges: [
    { id: "e-workflow-plan", source: "workflow", target: "plan", kind: "sequence" },
    { id: "e-plan-implement", source: "plan", target: "implement", kind: "sequence" },
    { id: "e-implement-verify", source: "implement", target: "verify", kind: "sequence" }
  ]
};

const run = (overrides = {}) => ({
  id: "run_1",
  status: "running",
  currentStep: "",
  error: null,
  pause: null,
  capabilityName: "Ship Feature",
  capabilitySlug: "ship-feature",
  ...overrides
});

const event = (type, node, createdAt, data = {}) => ({
  id: `evt_${type}_${createdAt}`,
  type,
  message: "",
  data: node ? { node, ...data } : data,
  createdAt
});

function statesById(flow) {
  return Object.fromEntries(flow.nodes.map((node) => [node.id, node.state]));
}

describe("buildRunFlow", () => {
  it("folds node lifecycle events onto the static graph", () => {
    const flow = buildRunFlow({
      run: run(),
      graph,
      events: [
        event("node.started", "plan", "2026-07-15T00:00:01.000Z"),
        event("node.finished", "plan", "2026-07-15T00:00:02.000Z"),
        event("node.started", "implement", "2026-07-15T00:00:03.000Z")
      ]
    });
    assert.deepEqual(statesById(flow), {
      workflow: "done",
      plan: "done",
      implement: "active",
      verify: "pending"
    });
    const plan = flow.nodes.find((node) => node.id === "plan");
    assert.equal(plan.startedAt, "2026-07-15T00:00:01.000Z");
    assert.equal(plan.finishedAt, "2026-07-15T00:00:02.000Z");
    assert.equal(flow.counts.done, 2);
    assert.equal(flow.counts.active, 1);
    assert.equal(flow.counts.pending, 1);
    assert.equal(flow.source, "workflow-source");
  });

  it("understands engine PascalCase events and nodeId payloads", () => {
    const flow = buildRunFlow({
      run: run(),
      graph,
      events: [
        { id: "e1", type: "NodeStarted", data: { nodeId: "plan" }, createdAt: "t1" },
        { id: "e2", type: "NodeFailed", data: { nodeId: "plan" }, createdAt: "t2" }
      ]
    });
    const plan = flow.nodes.find((node) => node.id === "plan");
    assert.equal(plan.state, "failed");
    assert.equal(plan.errors, 1);
  });

  it("parks a node in waiting on an unresolved engine approval, and releases it on resume", () => {
    const waiting = buildRunFlow({
      run: run(),
      graph,
      events: [
        event("node.started", "implement", "t1"),
        event("engine.approval.waiting", null, "t2", { nodeId: "implement" })
      ]
    });
    assert.equal(statesById(waiting).implement, "waiting");

    const resumed = buildRunFlow({
      run: run(),
      graph,
      events: [
        event("node.started", "implement", "t1"),
        event("engine.approval.waiting", null, "t2", { nodeId: "implement" }),
        event("engine.approval.resumed", null, "t3", { nodeId: "implement" })
      ]
    });
    assert.equal(statesById(resumed).implement, "active");
  });

  it("closes the books from the run status: succeeded finishes, cancelled cancels, failure fails, paused waits", () => {
    const events = [event("node.started", "implement", "t1")];
    assert.equal(statesById(buildRunFlow({ run: run({ status: "succeeded" }), graph, events })).implement, "done");
    assert.equal(statesById(buildRunFlow({ run: run({ status: "cancelled" }), graph, events })).implement, "cancelled");
    assert.equal(statesById(buildRunFlow({ run: run({ status: "failed" }), graph, events })).implement, "failed");
    assert.equal(statesById(buildRunFlow({ run: run({ status: "budget_exceeded" }), graph, events })).implement, "failed");
    assert.equal(statesById(buildRunFlow({ run: run({ status: "paused" }), graph, events })).implement, "waiting");
    // A failed run does NOT fail nodes that never started.
    assert.equal(statesById(buildRunFlow({ run: run({ status: "failed" }), graph, events })).verify, "pending");
  });

  it("reflects queue/approval state on the entry node and currentStep on pending nodes", () => {
    assert.equal(statesById(buildRunFlow({ run: run({ status: "queued" }), graph, events: [] })).workflow, "pending");
    assert.equal(statesById(buildRunFlow({ run: run({ status: "waiting_approval" }), graph, events: [] })).workflow, "waiting");
    const current = buildRunFlow({ run: run({ status: "running", currentStep: "verify" }), graph, events: [] });
    assert.equal(statesById(current).verify, "active");
  });

  it("degrades to an event-derived stepper when no graph exists, and surfaces unknown nodes", () => {
    const flow = buildRunFlow({
      run: run(),
      graph: null,
      events: [event("node.started", "surprise-step", "t1")]
    });
    assert.equal(flow.source, "events");
    const node = flow.nodes.find((entry) => entry.id === "surprise-step");
    assert.equal(node.state, "active");
    assert.equal(node.derivedFromEvents, true);
    assert.deepEqual(flow.edges, []);
    assert.equal(flow.name, "Ship Feature");
  });

  it("unwraps raw smithers.event engine lines into foldable node events", () => {
    const line = (type, nodeId, ts) => ({
      id: `evt_${type}_${ts}`,
      type: "smithers.event",
      message: JSON.stringify({ runId: "run-1", seq: 1, timestampMs: 1, type, payload: { type, nodeId, iteration: 0 } }),
      data: {},
      createdAt: ts
    });
    const unwrapped = unwrapEngineEvent(line("NodeStarted", "plan", "t1"));
    assert.equal(unwrapped.type, "NodeStarted");
    assert.equal(unwrapped.data.nodeId, "plan");
    // Non-engine and unparseable events pass through untouched.
    assert.equal(unwrapEngineEvent({ type: "run.created", message: "x" }).type, "run.created");
    assert.equal(unwrapEngineEvent({ type: "smithers.event", message: "not json" }).type, "smithers.event");

    const flow = buildRunFlow({
      run: run(),
      graph,
      events: [
        line("NodeStarted", "plan", "2026-07-15T00:00:01.000Z"),
        line("NodeFinished", "plan", "2026-07-15T00:00:02.000Z"),
        line("NodeStarted", "implement", "2026-07-15T00:00:03.000Z")
      ]
    });
    assert.equal(statesById(flow).plan, "done");
    assert.equal(statesById(flow).implement, "active");
  });

  it("passes through pending approvals and counts every declared state", () => {
    const flow = buildRunFlow({
      run: run(),
      graph,
      events: [],
      pendingApprovals: [{ id: "appr_1", title: "Deploy?", kind: "workflow_gate", createdAt: "t", payload: { secret: "x" } }]
    });
    assert.deepEqual(flow.pendingApprovals, [{ id: "appr_1", title: "Deploy?", kind: "workflow_gate", createdAt: "t" }]);
    assert.deepEqual(Object.keys(flow.counts).sort(), [...FLOW_NODE_STATES].sort());
  });
});
