import {
  freshRerunInput,
  freshRerunUpdateQuery,
  resumeRunInput,
  resumeRunUpdateQuery
} from "./runSupervisorRecords.js";
import {
  markFreshRerunMeta,
  markResumeMeta,
  nextSupervisorAttempt,
  readSupervisorMeta
} from "./runSupervisorMeta.js";

function json(value, fallback = null) {
  if (value === undefined) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

export function createRunSupervisorRequeue({
  run,
  now,
  adjustRunnerActiveRuns,
  addRunEvent,
  recordRunLineage,
  runProgressMarker
}) {
  function requeueRunForResume(row, decision, checkpoint, observedStatus) {
    const fingerprint = decision.fingerprint || "";
    const nextAttempt = nextSupervisorAttempt(row);
    const progressMarker = runProgressMarker(row.id);
    const meta = markResumeMeta(readSupervisorMeta(row), { fingerprint, checkpoint, progressMarker });
    const timestamp = now();
    const input = resumeRunInput(row.input, { checkpoint, attempt: nextAttempt, timestamp });

    const query = resumeRunUpdateQuery({
      runId: row.id,
      attempt: nextAttempt,
      meta: json(meta, {}),
      input: json(input, {}),
      timestamp,
      observedStatus
    });
    const result = run(query.sql, query.params);
    if (!result.changes) return false;

    if (row.runner_id && (observedStatus === "assigned" || observedStatus === "running")) {
      adjustRunnerActiveRuns(row.runner_id, -1);
    }
    recordRunLineage(row.id, {
      attempt: nextAttempt,
      action: "resume",
      reason: decision.reason,
      fingerprint,
      prevRunnerId: row.runner_id,
      checkpoint
    });
    addRunEvent(row.id, "run.supervisor.resumed", `Hub resumed run from checkpoint (attempt ${nextAttempt})`, {
      attempt: nextAttempt,
      checkpoint,
      fingerprint,
      reason: decision.reason
    });
    return true;
  }

  function requeueRunFresh(row, { fingerprint = "", reason = "" } = {}) {
    const meta = markFreshRerunMeta(readSupervisorMeta(row));
    const nextAttempt = nextSupervisorAttempt(row);
    const input = freshRerunInput(row.input);
    const timestamp = now();
    const query = freshRerunUpdateQuery({
      runId: row.id,
      attempt: nextAttempt,
      meta: json(meta, {}),
      input: json(input, {}),
      timestamp
    });
    const result = run(query.sql, query.params);
    if (!result.changes) return false;
    recordRunLineage(row.id, { attempt: nextAttempt, action: "rerun", reason, fingerprint, prevRunnerId: row.runner_id, checkpoint: null });
    addRunEvent(row.id, "run.supervisor.rerun", `Hub re-ran run from a clean state after code repair (attempt ${nextAttempt})`, { attempt: nextAttempt, fingerprint, reason });
    return true;
  }

  return {
    requeueRunForResume,
    requeueRunFresh
  };
}
