import { parseMaybeJson } from "./dbNormalization.js";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function normalizeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    capabilityId: row.capability_id,
    capabilitySlug: row.capability_slug,
    capabilityName: row.capability_name,
    workflowVersion: row.workflow_version,
    runnerId: row.runner_id,
    status: row.status,
    currentStep: row.current_step,
    input: parseMaybeJson(row.input, {}),
    output: parseMaybeJson(row.output, null),
    error: row.error,
    // Metered model-call usage aggregate + optional spend budget. Null until
    // the first usage record / when no budget was requested (src/runUsage.js).
    usage: parseMaybeJson(row.usage, null),
    budget: parseMaybeJson(row.budget, null),
    // Pause metadata for first-class paused runs (src/runPause.js). Null until
    // the run first pauses; kept (with resumedAt) after a resume as history.
    pause: parseMaybeJson(row.pause, null),
    // Capability version pinning + rollback parentage. Both stay null on the
    // existing path (RUNYARD_CAPABILITY_VERSIONING unset); see src/runExecution.js.
    capabilitySha: row.capability_sha || null,
    parentRunId: row.parent_run_id || null,
    // Durable work item ("ticket") this run executes for. Null = unlinked
    // (every pre-existing run); see src/workItemStore.js for link/unlink.
    workItemId: row.work_item_id || null,
    // Historical columns retained for old databases; no active runtime path
    // mutates them after supervisor removal.
    attempt: Number(row.attempt) || 0,
    repairCount: Number(row.repair_count) || 0,
    createdAt: row.created_at,
    assignedAt: row.assigned_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

export function approvalPolicyRequiresRunStartApproval(policy = {}) {
  if (!policy || typeof policy !== "object") return false;
  return policy.runStartApproval === true || policy.requireRunStartApproval === true || policy.workflowStartApproval === true;
}

export function runCreateRecord({
  runId,
  capability,
  input,
  options = {},
  approvalRequired = false,
  budget = null,
  timestamp
}) {
  const capabilitySha = options.capabilitySha ? String(options.capabilitySha).trim() || null : null;
  const parentRunId = options.parentRunId ? String(options.parentRunId).trim() || null : null;
  const workItemId = options.workItemId ? String(options.workItemId).trim() || null : null;
  return [
    runId,
    capability.id,
    capability.slug,
    capability.name,
    capability.version,
    options.runnerId || null,
    approvalRequired ? "waiting_approval" : "queued",
    approvalRequired ? "waiting for approval" : "queued",
    jsonField(input, {}),
    capabilitySha,
    parentRunId,
    workItemId,
    budget ? JSON.stringify(budget) : null,
    timestamp,
    timestamp
  ];
}

export function runInsertQuery() {
  return {
    sql: `INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version, runner_id, status,
      current_step, input, capability_sha, parent_run_id, work_item_id, budget, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  };
}

export function runLookupQuery(runId) {
  return {
    sql: "SELECT * FROM runs WHERE id = ?",
    params: [runId]
  };
}

export function runOwnerTokenQuery(runId) {
  return {
    sql: `SELECT runners.token_id AS token_id
       FROM runs
       JOIN runners ON runners.id = runs.runner_id
      WHERE runs.id = ?`,
    params: [runId]
  };
}

export function runStartApprovalPayload({
  capability,
  input,
  requestedBy = "workflow",
  notifyTelegram = false,
  origin = null,
  execution = null
}) {
  const payload = {
    kind: "run_start",
    approvalKind: "run_start",
    approvalScope: "workflow_start",
    capability: capability.slug,
    capabilityName: capability.name,
    workflow: {
      slug: capability.slug,
      name: capability.name,
      version: capability.version,
      engine: capability.workflow?.engine || "",
      entry: capability.workflow?.entry || ""
    },
    requestedBy,
    notifyTelegram,
    input
  };
  if (origin) payload.origin = origin;
  if (execution?.requested) payload.execution = execution;
  return payload;
}

export function runUpdateParams({ runId, updates, allowed, updatedAt }) {
  const sets = [];
  const params = { id: runId, updated_at: updatedAt };
  for (const [key, value] of Object.entries(updates || {})) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key}=$${key}`);
    params[key] = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
  }
  return { sets, params };
}

export function runUpdateQuery({ sets, params }) {
  return {
    sql: `UPDATE runs SET ${sets.join(", ")}, updated_at=$updated_at WHERE id=$id`,
    params
  };
}

export function runClaimAssignmentQuery({ runId, runnerId, timestamp }) {
  return {
    sql: "UPDATE runs SET runner_id=?, status='assigned', current_step='assigned to runner', assigned_at=?, updated_at=? WHERE id=? AND status='queued' AND (runner_id IS NULL OR runner_id=?)",
    params: [runnerId, timestamp, timestamp, runId, runnerId]
  };
}

export function runEventRecord({ id, runId, type, message = "", data = {}, createdAt }) {
  return {
    id,
    run_id: runId,
    type,
    message,
    data: jsonField(data, {}),
    created_at: createdAt
  };
}

// Assigns the per-run seq inside the INSERT itself (COALESCE(MAX(seq),-1)+1,
// the same next-seq rule as Smithers' insertEventWithNextSeq). A single
// statement is atomic in SQLite, so two inserts for the same run can never
// draw the same seq — the unique (run_id, seq) index is the backstop.
export function runEventInsertQuery() {
  return {
    sql: `INSERT INTO run_events (id, run_id, type, message, data, seq, created_at)
     VALUES ($id, $run_id, $type, $message, $data,
       (SELECT COALESCE(MAX(seq), -1) + 1 FROM run_events WHERE run_id = $run_id),
       $created_at)`
  };
}

export function runEventSeqLookupQuery(eventId) {
  return {
    sql: "SELECT seq FROM run_events WHERE id = ?",
    params: [eventId]
  };
}

// seq is the canonical replay order. The (seq IS NULL) guard keeps any row an
// older binary inserted without a seq (downgrade window) at the tail in
// created-at order instead of SQLite's NULLs-first default.
const RUN_EVENT_ORDER = "(seq IS NULL) ASC, seq ASC, created_at ASC, rowid ASC";

export function runEventListQuery(runId) {
  return {
    sql: `SELECT * FROM run_events WHERE run_id = ? ORDER BY ${RUN_EVENT_ORDER}`,
    params: [runId]
  };
}

// Cursor page for SSE replay / resume: strictly after `afterSeq`, bounded.
export function runEventPageQuery({ runId, afterSeq = -1, limit = 200 }) {
  return {
    sql: "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    params: [runId, Math.floor(afterSeq), Math.max(1, Math.min(1000, Math.floor(limit) || 200))]
  };
}

// Backfill helpers for migrateRunEventsSeqColumn (src/db.js). Deterministic
// order for historical rows: insertion order (created_at, then rowid).
export function runEventSeqBackfillQueries() {
  return {
    hasNullSeq: { sql: "SELECT 1 AS present FROM run_events WHERE seq IS NULL LIMIT 1", params: [] },
    runsWithNullSeq: { sql: "SELECT DISTINCT run_id FROM run_events WHERE seq IS NULL", params: [] },
    maxSeqForRun: { sql: "SELECT COALESCE(MAX(seq), -1) AS max_seq FROM run_events WHERE run_id = ?" },
    nullSeqRowsForRun: {
      sql: "SELECT id FROM run_events WHERE run_id = ? AND seq IS NULL ORDER BY created_at ASC, rowid ASC"
    },
    assignSeq: { sql: "UPDATE run_events SET seq = ? WHERE id = ?" }
  };
}

export function normalizeRunEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    message: row.message,
    data: parseMaybeJson(row.data, {}),
    // Monotonic per-run cursor; null only for rows written by a pre-seq
    // binary that have not been backfilled yet.
    seq: row.seq === null || row.seq === undefined ? null : Number(row.seq),
    createdAt: row.created_at
  };
}
