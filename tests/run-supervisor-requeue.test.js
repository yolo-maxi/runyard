import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRunSupervisorRequeue } from "../src/runSupervisorRequeue.js";

function harness({ changes = 1 } = {}) {
  const calls = {
    adjusted: [],
    events: [],
    lineage: [],
    runs: []
  };
  const requeue = createRunSupervisorRequeue({
    run: (sql, params) => {
      calls.runs.push({ sql, params });
      return { changes };
    },
    now: () => "2026-01-01T00:00:00.000Z",
    adjustRunnerActiveRuns: (...args) => calls.adjusted.push(args),
    addRunEvent: (...args) => calls.events.push(args),
    recordRunLineage: (...args) => calls.lineage.push(args),
    runProgressMarker: () => 7
  });
  return { calls, requeue };
}

describe("run supervisor requeue helpers", () => {
  it("resumes a run from a checkpoint and records operational side effects", () => {
    const { calls, requeue } = harness();

    const resumed = requeue.requeueRunForResume(
      {
        id: "run_1",
        attempt: 2,
        input: "{\"topic\":\"x\"}",
        runner_id: "runner_1",
        supervisor_meta: "{\"fingerprintResumes\":{\"fp\":1}}"
      },
      { fingerprint: "fp", reason: "runner went offline" },
      "smithers_1",
      "running"
    );

    assert.equal(resumed, true);
    assert.match(calls.runs[0].sql, /queued \(resume from checkpoint\)/);
    assert.equal(calls.runs[0].params.id, "run_1");
    assert.equal(calls.runs[0].params.attempt, 3);
    assert.deepEqual(JSON.parse(calls.runs[0].params.input).__resume, {
      smithersRunId: "smithers_1",
      attempt: 3,
      at: "2026-01-01T00:00:00.000Z"
    });
    assert.equal(JSON.parse(calls.runs[0].params.meta).fingerprintResumes.fp, 2);
    assert.deepEqual(calls.adjusted, [["runner_1", -1]]);
    assert.deepEqual(calls.lineage[0], ["run_1", {
      attempt: 3,
      action: "resume",
      reason: "runner went offline",
      fingerprint: "fp",
      prevRunnerId: "runner_1",
      checkpoint: "smithers_1"
    }]);
    assert.equal(calls.events[0][1], "run.supervisor.resumed");
  });

  it("does not emit side effects when the resume update loses the race", () => {
    const { calls, requeue } = harness({ changes: 0 });

    const resumed = requeue.requeueRunForResume(
      { id: "run_1", attempt: 1, input: "{}", runner_id: "runner_1", supervisor_meta: "{}" },
      { fingerprint: "fp", reason: "stale" },
      "smithers_1",
      "running"
    );

    assert.equal(resumed, false);
    assert.equal(calls.adjusted.length, 0);
    assert.equal(calls.lineage.length, 0);
    assert.equal(calls.events.length, 0);
  });

  it("requeues a failed run fresh after repair and strips resume state", () => {
    const { calls, requeue } = harness();

    const rerun = requeue.requeueRunFresh(
      {
        id: "run_2",
        attempt: 4,
        input: "{\"topic\":\"x\",\"__resume\":{\"smithersRunId\":\"old\"}}",
        runner_id: "runner_2",
        supervisor_meta: "{\"awaitingRepair\":true,\"adjudicated\":true}"
      },
      { fingerprint: "fp2", reason: "repair applied" }
    );

    assert.equal(rerun, true);
    assert.match(calls.runs[0].sql, /queued \(re-run after code repair\)/);
    assert.equal(calls.runs[0].params.attempt, 5);
    assert.deepEqual(JSON.parse(calls.runs[0].params.input), { topic: "x" });
    assert.equal(JSON.parse(calls.runs[0].params.meta).awaitingRepair, false);
    assert.deepEqual(calls.lineage[0], ["run_2", {
      attempt: 5,
      action: "rerun",
      reason: "repair applied",
      fingerprint: "fp2",
      prevRunnerId: "runner_2",
      checkpoint: null
    }]);
    assert.equal(calls.events[0][1], "run.supervisor.rerun");
  });
});
