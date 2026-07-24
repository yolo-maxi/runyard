import {
  runTransitionDecision,
  shouldReleaseRunnerSlotOnTransition
} from "./runLifecyclePolicy.js";
import {
  runUpdateParams,
  runUpdateQuery
} from "./runRecords.js";
import { runStatusCountQuery } from "./runnerPoolRecords.js";

// `input` is mutable only for the resume path, which re-queues a paused run
// with the recorded Smithers checkpoint injected as input.__resume; `pause`
// carries the pause metadata record (src/runPauseStore.js).
const RUN_UPDATE_FIELDS = ["runner_id", "status", "current_step", "input", "output", "error", "usage", "pause", "runner_state", "assigned_at", "started_at", "completed_at"];

export function createRunMutationStore({ one, run, now, getRun, adjustRunnerActiveRuns, onRunStatusChange }) {
  // updateRun is the single choke point where a run's status column is
  // written (transitionRun AND the approval-resolution path both land here),
  // so the optional onRunStatusChange observer sees every status move — it
  // powers the work-item board sync. Observer failures never break the
  // mutation (the sync layer already swallows its own errors).
  function updateRun(runId, updates) {
    const before = updates.status !== undefined ? getRun(runId) : null;
    const { sets, params } = runUpdateParams({
      runId,
      updates,
      allowed: RUN_UPDATE_FIELDS,
      updatedAt: now()
    });
    if (!sets.length) return getRun(runId);
    const query = runUpdateQuery({ sets, params });
    run(query.sql, query.params);
    const updated = getRun(runId);
    if (before && updated && onRunStatusChange && updated.status !== before.status) {
      onRunStatusChange(updated, before.status);
    }
    return updated;
  }

  function transitionRun(runId, toStatus, updates = {}) {
    const current = getRun(runId);
    const decision = runTransitionDecision(current, toStatus);
    if (!decision.ok) return { ...decision, run: current || undefined };
    if (decision.idempotent) return { ...decision, run: current };
    const updated = updateRun(runId, { status: toStatus, ...updates });
    if (shouldReleaseRunnerSlotOnTransition(current, toStatus)) {
      adjustRunnerActiveRuns(current.runnerId, -1);
    }
    return { ok: true, run: updated };
  }

  function countActiveRuns() {
    const query = runStatusCountQuery(["assigned", "running"]);
    return one(query.sql, query.params).count;
  }

  function countRunningRuns() {
    const query = runStatusCountQuery("running");
    return one(query.sql, query.params).count;
  }

  return {
    countActiveRuns,
    countRunningRuns,
    transitionRun,
    updateRun
  };
}
