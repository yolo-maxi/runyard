export function installProcessSafetyHandlers({ processObj = process, logError = console.error } = {}) {
  // Reliability net: a single malformed request must never take down the live
  // control plane. Express 4 does not catch async-handler rejections, so a
  // throw inside an async route can become an unhandledRejection that kills the
  // process. Log and keep serving; each request is independent and SQLite is
  // durable (WAL), so staying up beats dropping in-flight operator sessions.
  processObj.on("unhandledRejection", (reason) => {
    logError("unhandledRejection (hub stays up):", reason instanceof Error ? reason.stack : reason);
  });
  processObj.on("uncaughtException", (error) => {
    logError("uncaughtException (hub stays up):", error?.stack || error);
  });
}

export function startRunMaintenance({
  ciMaintenanceTick,
  env,
  logError = console.error,
  logInfo = console.log,
  pruneDeadRunners,
  reapStuckRunsWithRetrospectives,
  reconcileRunnerActiveRuns,
  setIntervalFn = setInterval,
  sweepSupersededApprovals,
  sweepTimedApprovals
} = {}) {
  const reaper = setIntervalFn(() => {
    try {
      // Timed approvals run before the reaper so a fallback decision that
      // unblocks a run (e.g. waiting_approval -> queued) lands in the same
      // tick. Blocking approvals (no timer) are never touched: they hold the
      // run open until a human decides, per the approval-hold contract.
      const swept = sweepTimedApprovals ? sweepTimedApprovals() : [];
      if (swept.length) {
        logInfo(
          `Timed approvals swept: ` +
            swept.map((entry) => `${entry.id} ${entry.action}${entry.decision ? `:${entry.decision}` : ""}`).join(", ")
        );
      }
    } catch (error) {
      logError("Timed-approval sweep failed:", error.message);
    }
    try {
      // Terminal-run card hygiene: pending cards whose run already ended are
      // resolved as superseded so the approval inbox only holds live
      // questions. Runs in waiting_approval are not terminal and are never
      // touched — blocking approvals keep holding their runs.
      const superseded = sweepSupersededApprovals ? sweepSupersededApprovals() : [];
      if (superseded.length) {
        logInfo(
          `Superseded approvals swept: ` +
            superseded.map((entry) => `${entry.id} (run ${entry.runId} ${entry.runStatus})`).join(", ")
        );
      }
    } catch (error) {
      logError("Superseded-approval sweep failed:", error.message);
    }
    try {
      reapStuckRunsWithRetrospectives(env.runDeadlineMs);
    } catch (error) {
      logError("Run reaper failed:", error.message);
    }
    try {
      // Recompute cached active_runs from real run state before pruning, so a
      // stale "full" counter cannot wedge the queue or block idle runner prune.
      const corrected = reconcileRunnerActiveRuns();
      if (corrected.length) {
        logInfo(
          `Reconciled active_runs for ${corrected.length} runner(s): ` +
            corrected.map((c) => `${c.id} ${c.from}->${c.to}`).join(", ")
        );
      }
    } catch (error) {
      logError("active_runs reconcile failed:", error.message);
    }
    try {
      const pruned = pruneDeadRunners(env.runnerPruneMs);
      if (pruned.length) logInfo(`Pruned ${pruned.length} dead runner(s): ${pruned.join(", ")}`);
    } catch (error) {
      logError("Runner pruner failed:", error.message);
    }
    try {
      // CI platform: advance active pipeline DAGs (restart/recovery backstop
      // for the event-driven fast path), prune the webhook delivery ledger,
      // and reconcile GitHub check state.
      if (ciMaintenanceTick) ciMaintenanceTick();
    } catch (error) {
      logError("CI maintenance failed:", error.message);
    }
  }, 60_000);
  reaper.unref?.();
  return reaper;
}

export function startScheduleTicker({
  fireDueSchedules,
  logError = console.error,
  setIntervalFn = setInterval
} = {}) {
  // Tick every 30s so minute-granular schedules fire within ~30s of their
  // boundary. Firing is idempotent and missed ticks collapse to one run.
  const scheduler = setIntervalFn(() => {
    try {
      fireDueSchedules();
    } catch (error) {
      logError("Schedule ticker failed:", error.message);
    }
  }, 30_000);
  scheduler.unref?.();
  return scheduler;
}

export function startUpdatePolling({
  env,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  updateChecker
} = {}) {
  if (!env.updateCheckEnabled) return {};

  // Passive, outbound-only update check. Refreshes the cached latest-release
  // reading for the admin badge. It never installs anything; failures degrade
  // to "unknown" inside check(). First run is delayed so slow GitHub never
  // blocks startup.
  const runUpdateCheck = () => {
    updateChecker.check().catch(() => {});
  };
  const kick = setTimeoutFn(runUpdateCheck, 5_000);
  kick.unref?.();
  const updatePoll = setIntervalFn(runUpdateCheck, Math.max(60_000, env.updateCheckIntervalMs));
  updatePoll.unref?.();
  return { kick, updatePoll };
}

export function startServerRuntime({
  app,
  ciMaintenanceTick,
  env,
  fireDueSchedules,
  logError = console.error,
  logInfo = console.log,
  processObj = process,
  pruneDeadRunners,
  reapStuckRunsWithRetrospectives,
  reconcileRunnerActiveRuns,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  sweepSupersededApprovals,
  sweepTimedApprovals,
  updateChecker
} = {}) {
  installProcessSafetyHandlers({ processObj, logError });
  const server = app.listen(env.port, env.host, () => {
    logInfo(`${env.instanceName} listening on http://${env.host}:${env.port}`);
  });
  const reaper = startRunMaintenance({
    ciMaintenanceTick,
    env,
    logError,
    logInfo,
    pruneDeadRunners,
    reapStuckRunsWithRetrospectives,
    reconcileRunnerActiveRuns,
    setIntervalFn,
    sweepSupersededApprovals,
    sweepTimedApprovals
  });
  const scheduler = startScheduleTicker({ fireDueSchedules, logError, setIntervalFn });
  const updatePolling = startUpdatePolling({ env, setIntervalFn, setTimeoutFn, updateChecker });
  return { reaper, scheduler, server, ...updatePolling };
}
