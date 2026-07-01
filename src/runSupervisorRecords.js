import { parseMaybeJson } from "./dbNormalization.js";
export {
  clearAwaitingRepairMeta,
  markFreshRerunMeta,
  markRepairDispatchedMeta,
  markResumeMeta,
  markTerminalMeta,
  nextSupervisorAttempt,
  normalizeSupervisorMeta,
  readSupervisorMeta
} from "./runSupervisorMeta.js";

export function normalizeRunLineage(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    attempt: row.attempt,
    action: row.action,
    reason: row.reason,
    fingerprint: row.fingerprint,
    prevRunnerId: row.prev_runner_id,
    checkpoint: row.checkpoint,
    createdAt: row.created_at
  };
}

export function runLineageRecord({ id, runId, entry = {}, timestamp }) {
  return {
    id,
    run_id: runId,
    attempt: Number(entry.attempt) || 0,
    action: String(entry.action || ""),
    reason: String(entry.reason || "").slice(0, 600),
    fingerprint: String(entry.fingerprint || "").slice(0, 200),
    prev_runner_id: entry.prevRunnerId || null,
    checkpoint: entry.checkpoint || null,
    created_at: timestamp
  };
}

export function runLineageInsertQuery() {
  return {
    sql: `INSERT INTO run_lineage (id, run_id, attempt, action, reason, fingerprint, prev_runner_id, checkpoint, created_at)
     VALUES ($id, $run_id, $attempt, $action, $reason, $fingerprint, $prev_runner_id, $checkpoint, $created_at)`
  };
}

export function runLineageListQuery(runId) {
  return {
    sql: "SELECT * FROM run_lineage WHERE run_id = ? ORDER BY created_at ASC",
    params: [runId]
  };
}

export function resumeRunInput(inputValue, { checkpoint, attempt, timestamp }) {
  return {
    ...parseMaybeJson(inputValue, {}),
    __resume: { smithersRunId: checkpoint, attempt, at: timestamp }
  };
}

export function freshRerunInput(inputValue) {
  const input = parseMaybeJson(inputValue, {});
  delete input.__resume;
  return input;
}

export function waitingApprovalInputsQuery() {
  return {
    sql: "SELECT input FROM runs WHERE status = 'waiting_approval' ORDER BY created_at DESC LIMIT 500",
    params: []
  };
}

export function waitingApprovalBelongsToParent(row, parentRunId) {
  if (!parentRunId) return false;
  const input = parseMaybeJson(row?.input, {});
  return input?.__origin?.parentRunId === parentRunId;
}

export function resumeCheckpointEventQuery(runId) {
  return {
    sql: `SELECT data FROM run_events
      WHERE run_id = ? AND type = 'smithers.dispatched'
      ORDER BY created_at DESC LIMIT 1`,
    params: [runId]
  };
}

export function resumeCheckpointFromEvent(row) {
  if (!row) return null;
  const smithersRunId = parseMaybeJson(row.data, {})?.smithersRunId;
  return smithersRunId ? String(smithersRunId) : null;
}

export function runProgressMarkerQuery(runId) {
  return {
    sql: "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?",
    params: [runId]
  };
}

export function supervisingParentId(input) {
  const origin = input?.__origin;
  return origin?.parentRunId || input?.__supervisedChild?.parentRunId || "";
}

export function supervisingParentStatusQuery(parentRunId) {
  return {
    sql: "SELECT status FROM runs WHERE id = ?",
    params: [String(parentRunId)]
  };
}

export function supervisorRunStatusInputQuery(runId) {
  return {
    sql: "SELECT id, status, input FROM runs WHERE id = ?",
    params: [String(runId)]
  };
}

export function supervisorRunLookupQuery(runId) {
  return {
    sql: "SELECT * FROM runs WHERE id = ?",
    params: [String(runId)]
  };
}

export function supervisedChildTerminalCandidatesQuery({ supervisorCapabilitySlug = "run-smithers", limit = 100 } = {}) {
  return {
    sql: `SELECT parent.*,
            child.id AS child_id,
            child.status AS child_status,
            child.error AS child_error,
            child.output AS child_output,
            child.completed_at AS child_completed_at
       FROM runs parent
       JOIN runs child
         ON json_extract(child.input, '$.__origin.parentRunId') = parent.id
      WHERE parent.capability_slug = ?
        AND parent.status IN ('queued','assigned','running')
        AND child.status IN (
          'succeeded','failed','blocked_by_gate','blocked_by_preflight',
          'provider_limited','timed_out','invalid_output','infra_unavailable',
          'needs_human','cancelled'
        )
      ORDER BY child.completed_at DESC, child.updated_at DESC
      LIMIT ?`,
    params: [supervisorCapabilitySlug, Math.max(1, Math.floor(Number(limit) || 100))]
  };
}

export function supervisorMetaUpdateQuery({ runId, meta }) {
  return {
    sql: "UPDATE runs SET supervisor_meta=? WHERE id=?",
    params: [meta, runId]
  };
}

export function resumeRunUpdateQuery({ runId, attempt, meta, input, timestamp, observedStatus }) {
  return {
    sql: `UPDATE runs
        SET status='queued', runner_id=NULL, current_step='queued (resume from checkpoint)',
            error=NULL, attempt=$attempt, supervisor_meta=$meta, input=$input,
            completed_at=NULL, updated_at=$ts
      WHERE id=$id AND status=$observed`,
    params: { id: runId, attempt, meta, input, ts: timestamp, observed: observedStatus }
  };
}

export function freshRerunUpdateQuery({ runId, attempt, meta, input, timestamp }) {
  return {
    sql: `UPDATE runs
        SET status='queued', runner_id=NULL, current_step='queued (re-run after code repair)',
            error=NULL, attempt=$attempt, supervisor_meta=$meta, input=$input,
            completed_at=NULL, updated_at=$ts
      WHERE id=$id AND status='failed'`,
    params: { id: runId, attempt, meta, input, ts: timestamp }
  };
}

export function repairDispatchedUpdateQuery({ runId, repairCount, meta }) {
  return {
    sql: "UPDATE runs SET repair_count=?, supervisor_meta=? WHERE id=?",
    params: [repairCount, meta, runId]
  };
}

export function activeReapCandidatesQuery() {
  return {
    sql: `SELECT runs.id,
            runs.runner_id,
            runs.status,
            runs.capability_slug,
            runs.input,
            runs.attempt,
            runs.repair_count,
            runs.supervisor_meta,
            runs.created_at,
            runs.assigned_at,
            runs.started_at,
            runners.last_heartbeat_at,
            (SELECT MAX(created_at) FROM run_events WHERE run_id = runs.id) AS last_event_at
       FROM runs
       LEFT JOIN runners ON runners.id = runs.runner_id
      WHERE runs.status IN ('assigned','running','waiting_approval')`,
    params: []
  };
}

export function failedRecoverableCandidatesQuery({ since, limit }) {
  return {
    sql: `SELECT id,
            runner_id,
            status,
            capability_slug,
            input,
            attempt,
            repair_count,
            supervisor_meta,
            error,
            (SELECT json_extract(data, '$.reason')
               FROM run_events
              WHERE run_events.run_id = runs.id
                AND run_events.type = 'run.failed'
              ORDER BY created_at DESC
              LIMIT 1) AS failure_reason
       FROM runs
      WHERE status = 'failed' AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT ?`,
    params: [since, Math.max(1, Math.floor(limit))]
  };
}
