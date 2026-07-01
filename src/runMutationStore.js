import {
  runTransitionDecision,
  shouldReleaseRunnerSlotOnTransition
} from "./runLifecyclePolicy.js";
import {
  runUpdateParams,
  runUpdateQuery
} from "./runRecords.js";
import { runStatusCountQuery } from "./runnerPoolRecords.js";

const RUN_UPDATE_FIELDS = ["runner_id", "status", "current_step", "output", "error", "assigned_at", "started_at", "completed_at"];

export function createRunMutationStore({ one, run, now, getRun, adjustRunnerActiveRuns }) {
  function updateRun(runId, updates) {
    const { sets, params } = runUpdateParams({
      runId,
      updates,
      allowed: RUN_UPDATE_FIELDS,
      updatedAt: now()
    });
    if (!sets.length) return getRun(runId);
    const query = runUpdateQuery({ sets, params });
    run(query.sql, query.params);
    return getRun(runId);
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
