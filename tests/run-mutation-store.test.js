import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRunMutationStore } from "../src/runMutationStore.js";

const runningRun = {
  id: "run_1",
  status: "running",
  runnerId: "runner_1",
  currentStep: "working"
};

function createHarness({ runs = [runningRun], countRows = [] } = {}) {
  const calls = [];
  const releases = [];
  const runRows = [...runs];
  const counts = [...countRows];
  const store = createRunMutationStore({
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return counts.length ? counts.shift() : { count: 0 };
    },
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: 1 };
    },
    now: () => "2026-07-01T00:00:00.000Z",
    getRun: () => runRows.length ? runRows.shift() : runningRun,
    adjustRunnerActiveRuns: (...args) => releases.push(args)
  });
  return { calls, releases, store };
}

describe("run mutation store", () => {
  it("updates allowed run fields and reloads the run", () => {
    const updated = { ...runningRun, currentStep: "done" };
    const { calls, store } = createHarness({ runs: [updated] });

    const run = store.updateRun("run_1", {
      current_step: "done",
      ignored: "nope",
      output: { ok: true }
    });

    assert.equal(run.currentStep, "done");
    const write = calls.find((call) => call.fn === "run");
    assert.match(write.sql, /current_step=\$current_step/);
    assert.match(write.sql, /output=\$output/);
    assert.doesNotMatch(write.sql, /ignored/);
    assert.equal(write.params.output, '{"ok":true}');
  });

  it("reloads without writing when no allowed fields are present", () => {
    const { calls, store } = createHarness();

    assert.equal(store.updateRun("run_1", { ignored: true }).id, "run_1");
    assert.equal(calls.some((call) => call.fn === "run"), false);
  });

  it("transitions active runs and releases their runner slot once", () => {
    const succeeded = { ...runningRun, status: "succeeded" };
    const { releases, store } = createHarness({ runs: [runningRun, succeeded] });

    assert.deepEqual(store.transitionRun("run_1", "succeeded", { completed_at: "done" }), {
      ok: true,
      run: succeeded
    });
    assert.deepEqual(releases, [["runner_1", -1]]);
  });

  it("returns transition errors and terminal idempotency without writing", () => {
    const missingHarness = createHarness({ runs: [null] });
    assert.deepEqual(missingHarness.store.transitionRun("missing", "running"), {
      ok: false,
      code: 404,
      error: "run not found",
      run: undefined
    });
    assert.equal(missingHarness.calls.some((call) => call.fn === "run"), false);

    const terminal = { ...runningRun, status: "succeeded" };
    const terminalHarness = createHarness({ runs: [terminal] });
    assert.deepEqual(terminalHarness.store.transitionRun("run_1", "succeeded"), {
      ok: true,
      idempotent: true,
      run: terminal
    });
    assert.equal(terminalHarness.calls.some((call) => call.fn === "run"), false);
  });

  it("counts active and running runs", () => {
    const { calls, store } = createHarness({ countRows: [{ count: 3 }, { count: 2 }] });

    assert.equal(store.countActiveRuns(), 3);
    assert.equal(store.countRunningRuns(), 2);
    assert.deepEqual(calls.filter((call) => call.fn === "one").map((call) => call.params), [
      ["assigned", "running"],
      ["running"]
    ]);
  });
});
