import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  installProcessSafetyHandlers,
  startRunMaintenance,
  startScheduleTicker,
  startServerRuntime,
  startUpdatePolling
} from "../src/serverRuntime.js";

function timer(label, callbacks) {
  return (callback, ms) => {
    callbacks.push({ callback, label, ms });
    return { label, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
  };
}

describe("server runtime helpers", () => {
  it("installs process-level safety handlers", () => {
    const handlers = {};
    const logs = [];
    installProcessSafetyHandlers({
      processObj: { on: (event, handler) => { handlers[event] = handler; } },
      logError: (...entry) => logs.push(entry)
    });

    handlers.unhandledRejection(new Error("async failed"));
    handlers.uncaughtException(new Error("sync failed"));

    assert.deepEqual(Object.keys(handlers).sort(), ["uncaughtException", "unhandledRejection"]);
    assert.equal(logs[0][0], "unhandledRejection (hub stays up):");
    assert.match(logs[0][1], /async failed/);
    assert.equal(logs[1][0], "uncaughtException (hub stays up):");
  });

  it("runs maintenance tasks and logs recoveries", () => {
    const callbacks = [];
    const info = [];
    const reaper = startRunMaintenance({
      dispatchHubRepair: () => {},
      env: { hubSupervisorRepairEnabled: true, runDeadlineMs: 10, runnerPruneMs: 20 },
      logError: () => {},
      logInfo: (line) => info.push(line),
      pruneDeadRunners: (ms) => [`pruned_${ms}`],
      reapStuckRunsWithRetrospectives: (ms) => info.push(`reap ${ms}`),
      reconcileFailedRecoverable: ({ dispatchRepair }) => dispatchRepair ? ["run_1"] : [],
      reconcileRunnerActiveRuns: () => [{ id: "runner_1", from: 2, to: 1 }],
      setIntervalFn: timer("interval", callbacks),
      sweepTimedApprovals: () => [
        { id: "appr_1", action: "fallback_applied", decision: "approved" },
        { id: "appr_2", action: "fallback_required" }
      ]
    });

    callbacks[0].callback();

    assert.equal(callbacks[0].ms, 60_000);
    assert.equal(reaper.unrefCalled, true);
    assert.deepEqual(info, [
      "Timed approvals swept: appr_1 fallback_applied:approved, appr_2 fallback_required",
      "reap 10",
      "Hub supervisor reconciled 1 failed-recoverable run(s): run_1",
      "Reconciled active_runs for 1 runner(s): runner_1 2->1",
      "Pruned 1 dead runner(s): pruned_20"
    ]);
  });

  it("logs and continues when maintenance subtasks fail", () => {
    const callbacks = [];
    const errors = [];
    startRunMaintenance({
      dispatchHubRepair: null,
      env: { hubSupervisorRepairEnabled: false, runDeadlineMs: 10, runnerPruneMs: 20 },
      logError: (...entry) => errors.push(entry),
      logInfo: () => {},
      pruneDeadRunners: () => { throw new Error("prune failed"); },
      reapStuckRunsWithRetrospectives: () => { throw new Error("reap failed"); },
      reconcileFailedRecoverable: () => { throw new Error("reconcile failed"); },
      reconcileRunnerActiveRuns: () => { throw new Error("active failed"); },
      setIntervalFn: timer("interval", callbacks),
      sweepTimedApprovals: () => { throw new Error("sweep failed"); }
    });

    callbacks[0].callback();

    assert.deepEqual(errors.map((entry) => entry[0]), [
      "Timed-approval sweep failed:",
      "Run reaper failed:",
      "Hub supervisor reconcile failed:",
      "active_runs reconcile failed:",
      "Runner pruner failed:"
    ]);
  });

  it("ticks schedules and update checks with safe defaults", () => {
    const intervalCallbacks = [];
    const timeoutCallbacks = [];
    let fired = 0;
    const scheduler = startScheduleTicker({
      fireDueSchedules: () => { fired += 1; },
      setIntervalFn: timer("interval", intervalCallbacks)
    });
    intervalCallbacks[0].callback();
    assert.equal(intervalCallbacks[0].ms, 30_000);
    assert.equal(scheduler.unrefCalled, true);
    assert.equal(fired, 1);

    let checks = 0;
    const polling = startUpdatePolling({
      env: { updateCheckEnabled: true, updateCheckIntervalMs: 1 },
      setIntervalFn: timer("interval", intervalCallbacks),
      setTimeoutFn: timer("timeout", timeoutCallbacks),
      updateChecker: { check: () => { checks += 1; return Promise.resolve(); } }
    });
    timeoutCallbacks[0].callback();
    intervalCallbacks[1].callback();
    assert.equal(timeoutCallbacks[0].ms, 5_000);
    assert.equal(intervalCallbacks[1].ms, 60_000);
    assert.equal(polling.kick.unrefCalled, true);
    assert.equal(polling.updatePoll.unrefCalled, true);
    assert.equal(checks, 2);
  });

  it("starts the full runtime around an Express app", () => {
    const processHandlers = {};
    const intervals = [];
    const timeouts = [];
    const logs = [];
    const runtime = startServerRuntime({
      app: {
        listen(port, host, callback) {
          callback();
          return { port, host };
        }
      },
      dispatchHubRepair: null,
      env: {
        host: "127.0.0.1",
        hubSupervisorRepairEnabled: false,
        instanceName: "Runyard",
        port: 3000,
        runDeadlineMs: 1,
        runnerPruneMs: 2,
        updateCheckEnabled: false
      },
      fireDueSchedules: () => {},
      logError: () => {},
      logInfo: (line) => logs.push(line),
      processObj: { on: (event, handler) => { processHandlers[event] = handler; } },
      pruneDeadRunners: () => [],
      reapStuckRunsWithRetrospectives: () => {},
      reconcileFailedRecoverable: () => [],
      reconcileRunnerActiveRuns: () => [],
      setIntervalFn: timer("interval", intervals),
      setTimeoutFn: timer("timeout", timeouts),
      updateChecker: { check: () => Promise.resolve() }
    });

    assert.deepEqual(runtime.server, { port: 3000, host: "127.0.0.1" });
    assert.equal(intervals.length, 2);
    assert.equal(timeouts.length, 0);
    assert.deepEqual(Object.keys(processHandlers).sort(), ["uncaughtException", "unhandledRejection"]);
    assert.deepEqual(logs, ["Runyard listening on http://127.0.0.1:3000"]);
  });
});
