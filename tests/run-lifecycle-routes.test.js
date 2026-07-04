import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRunLifecycleHandlers,
  ifActiveTransition,
  sendTransitionError
} from "../src/runLifecycleRoutes.js";
import { mockResponse as response } from "./response.js";

function harness(overrides = {}) {
  const events = [];
  const createdRuns = [];
  const terminalArtifacts = [];
  const failureAlerts = [];
  const updates = [];
  const transitions = [];
  const engineResumes = [];
  const handlers = createRunLifecycleHandlers({
    resolveEngineApprovalOnResume: (runId, data) => {
      engineResumes.push({ runId, data });
      return [];
    },
    addRunEvent: (runId, type, message, detail) => {
      const event = { id: `event_${events.length + 1}`, runId, type, message, detail };
      events.push(event);
      return event;
    },
    createRun: (capability, input, options) => {
      const run = { id: `run_child_${createdRuns.length + 1}`, capabilitySlug: capability.slug, capabilityName: capability.name, input, options };
      createdRuns.push(run);
      return run;
    },
    getCapability: overrides.getCapability || ((slug) => ({ slug, name: "Next Capability", enabled: true })),
    maybeRecordFailureClassAlert: (status) => failureAlerts.push(status),
    recordRunTerminalArtifacts: (runId) => terminalArtifacts.push(runId),
    scrubStoredSecrets: overrides.scrubStoredSecrets || ((value) => (typeof value === "string" ? value.replace(/secret/g, "[redacted]") : value)),
    transitionRun: overrides.transitionRun || ((runId, status, patch) => {
      transitions.push({ runId, status, patch });
      return { ok: true, run: { id: runId, status, capabilitySlug: "parent", input: {} }, idempotent: false };
    }),
    updateRun: (runId, patch) => updates.push({ runId, patch }),
    withRunLinks: (run) => ({ ...run, deepLink: `#/runs/${run.id}` })
  });
  return { createdRuns, engineResumes, events, failureAlerts, handlers, terminalArtifacts, transitions, updates };
}

function req(body = {}, params = { id: "run_1" }) {
  return {
    body,
    params,
    headers: {},
    token: { id: "tok_1", name: "runner", scopes: ["runner"] }
  };
}

describe("run lifecycle route handlers", () => {
  it("centralizes transition error responses and active side effects", () => {
    const res = response();

    assert.equal(sendTransitionError(res, { ok: true }), false);
    assert.equal(sendTransitionError(res, { ok: false, code: 409, error: "bad transition" }), true);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: "bad transition" });

    let calls = 0;
    assert.equal(ifActiveTransition({ idempotent: true }, () => { calls += 1; }), null);
    assert.equal(ifActiveTransition({ idempotent: false }, () => { calls += 1; return "ran"; }), "ran");
    assert.equal(calls, 1);
  });

  it("records scrubbed run events and updates workflow steps", () => {
    const { events, handlers, updates } = harness();
    const res = response();
    handlers.recordRunEvent(req({ type: "workflow.step", message: "use secret", data: { keep: true } }), res);

    assert.equal(res.body.event.message, "use [redacted]");
    assert.equal(events[0].type, "workflow.step");
    assert.deepEqual(updates, [{ runId: "run_1", patch: { current_step: "use [redacted]" } }]);
  });

  it("mirrors engine-side approval decisions onto cards only for engine.approval.resumed events", () => {
    const { engineResumes, handlers } = harness();

    handlers.recordRunEvent(req({
      type: "engine.approval.resumed",
      message: "gate decided",
      data: { smithersRunId: "run_sm1", nodeId: "gate", engineDecision: "approved" }
    }), response());
    assert.equal(engineResumes.length, 1);
    assert.equal(engineResumes[0].runId, "run_1");
    assert.equal(engineResumes[0].data.engineDecision, "approved");

    handlers.recordRunEvent(req({ type: "engine.approval.waiting", message: "paused", data: {} }), response());
    handlers.recordRunEvent(req({ type: "log", message: "hello", data: {} }), response());
    assert.equal(engineResumes.length, 1);
  });

  it("starts runs idempotently without duplicate started events", () => {
    const { events, handlers } = harness({
      transitionRun: () => ({ ok: true, run: { id: "run_1", status: "running" }, idempotent: true })
    });
    const res = response();
    handlers.startRun(req(), res);

    assert.equal(res.body.run.status, "running");
    assert.deepEqual(events, []);
  });

  it("completes a run, queues the next chained run, and records terminal artifacts", () => {
    const parentRun = {
      id: "run_parent",
      status: "succeeded",
      capabilitySlug: "research",
      capabilityName: "Research",
      input: {
        __chain: [{ capability: "next-capability", input: { prompt: "continue" } }],
        __chainIndex: 0,
        __execution: { runnerLocation: "local" }
      }
    };
    const { createdRuns, events, handlers, terminalArtifacts, transitions } = harness({
      transitionRun: (_runId, status, patch) => ({ ok: true, run: { ...parentRun, status }, idempotent: false, patch })
    });
    const res = response();
    handlers.completeRun(req({ output: { answer: 42 } }, { id: "run_parent" }), res);

    assert.equal(transitions.length, 0, "custom transition does not record into default transition array");
    assert.equal(createdRuns[0].capabilitySlug, "next-capability");
    assert.equal(createdRuns[0].input.prompt, "continue");
    assert.deepEqual(createdRuns[0].input.previousOutput, { answer: 42 });
    assert.equal(createdRuns[0].options.origin.type, "workflow-chain");
    assert.deepEqual(terminalArtifacts, ["run_parent"]);
    assert.equal(res.body.chainedRun.id, "run_child_1");
    assert.deepEqual(events.map((event) => event.type), ["run.succeeded", "run.chain.queued", "run.chain.parent"]);
  });

  it("records classified failures, alerts, and terminal artifacts", () => {
    const { events, failureAlerts, handlers, terminalArtifacts, transitions } = harness();
    const res = response();
    handlers.failRun(req({ error: "provider returned 429" }), res);

    assert.equal(transitions[0].status, "provider_limited");
    assert.equal(events[0].type, "run.provider_limited");
    assert.deepEqual(events[0].detail, { failureClass: "provider_limited" });
    assert.deepEqual(failureAlerts, ["provider_limited"]);
    assert.deepEqual(terminalArtifacts, ["run_1"]);
  });

  it("records ignored late terminal transitions without terminal side effects", () => {
    const { events, failureAlerts, handlers, terminalArtifacts } = harness({
      transitionRun: () => ({ ok: true, run: { id: "run_1", status: "cancelled" }, idempotent: true, raced: true })
    });
    const res = response();
    handlers.failRun(req({ status: "failed", error: "late" }), res);

    assert.equal(events[0].type, "run.transition_ignored");
    assert.deepEqual(failureAlerts, []);
    assert.deepEqual(terminalArtifacts, []);
  });

  it("cancels runs with one terminal event and artifact pass", () => {
    const { events, handlers, terminalArtifacts, transitions } = harness();
    const res = response();
    handlers.cancelRun(req({ reason: "operator stop" }), res);

    assert.equal(transitions[0].status, "cancelled");
    assert.equal(events[0].type, "run.cancelled");
    assert.equal(events[0].message, "operator stop");
    assert.deepEqual(terminalArtifacts, ["run_1"]);
  });

  it("returns transition errors without recording side effects", () => {
    const { events, handlers, terminalArtifacts } = harness({
      transitionRun: () => ({ ok: false, code: 409, error: "invalid transition" })
    });
    const res = response();
    handlers.completeRun(req(), res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: "invalid transition" });
    assert.deepEqual(events, []);
    assert.deepEqual(terminalArtifacts, []);
  });
});
