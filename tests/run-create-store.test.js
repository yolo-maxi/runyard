import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRunCreateStore } from "../src/runCreateStore.js";

const capability = {
  id: "cap_1",
  slug: "deploy",
  name: "Deploy",
  version: 2,
  approvalPolicy: {},
  workflow: { engine: "smithers", entry: "deploy.tsx" }
};

function createHarness({ returnedRun = { id: "run_1", status: "queued" } } = {}) {
  const calls = [];
  const approvals = [];
  const events = [];
  const store = createRunCreateStore({
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: 1 };
    },
    id: (prefix) => `${prefix}_1`,
    now: () => "2026-07-01T00:00:00.000Z",
    scrubStoredSecrets: (input) => ({ ...input, scrubbed: true }),
    addRunEvent: (...args) => events.push(args),
    createApproval: (approval) => approvals.push(approval),
    getRun: (runId) => ({ ...returnedRun, id: runId })
  });
  return { approvals, calls, events, store };
}

describe("run create store", () => {
  it("creates queued runs with scrubbed input, origin metadata, and creation events", () => {
    const { approvals, calls, events, store } = createHarness();

    const run = store.createRun(capability, {
      target: "prod",
      __origin: { type: "existing" }
    }, {
      origin: { scheduleId: "sched_1" },
      execution: { runnerLocation: "local" }
    });

    assert.equal(run.id, "run_1");
    assert.equal(approvals.length, 0);
    const write = calls.find((call) => call.fn === "run");
    const storedInput = JSON.parse(write.params[8]);
    assert.equal(storedInput.target, "prod");
    assert.equal(storedInput.scrubbed, true);
    assert.equal(storedInput.__origin.type, "existing");
    assert.equal(storedInput.__origin.scheduleId, "sched_1");
    assert.equal(storedInput.__execution.runnerLocation, "local");
    assert.deepEqual(events[0], [
      "run_1",
      "run.created",
      "Run created for Deploy",
      {
        capability: "deploy",
        execution: {
          requested: true,
          mode: "local",
          runnerLocation: "local",
          sourceOfTruth: "hub",
          outputs: "hub",
          artifacts: "hub"
        }
      }
    ]);
  });

  it("creates waiting-approval runs and records approval payloads", () => {
    const { approvals, calls, store } = createHarness({ returnedRun: { id: "run_1", status: "waiting_approval" } });
    const gated = {
      ...capability,
      approvalPolicy: {
        runStartApproval: true,
        reason: "Production deploy",
        notifyTelegram: true
      }
    };

    const run = store.createRun(gated, { target: "prod" }, {
      requestedBy: "alice",
      origin: { type: "manual" }
    });

    assert.equal(run.status, "waiting_approval");
    assert.equal(JSON.parse(calls[0].params[8]).target, "prod");
    assert.equal(calls[0].params[6], "waiting_approval");
    assert.deepEqual(approvals[0], {
      runId: "run_1",
      title: "Approve Deploy",
      description: "Production deploy",
      requestedBy: "alice",
      payload: {
        kind: "run_start",
        approvalKind: "run_start",
        approvalScope: "workflow_start",
        capability: "deploy",
        capabilityName: "Deploy",
        workflow: {
          slug: "deploy",
          name: "Deploy",
          version: 2,
          engine: "smithers",
          entry: "deploy.tsx"
        },
        requestedBy: "alice",
        notifyTelegram: true,
        input: {
          target: "prod",
          scrubbed: true,
          __origin: { type: "manual" }
        },
        origin: { type: "manual" }
      }
    });
  });

  it("normalizes non-object run input to an empty stored object", () => {
    const { calls, store } = createHarness();

    store.createRun(capability, "not an object");

    assert.deepEqual(JSON.parse(calls[0].params[8]), { scrubbed: true });
  });
});
