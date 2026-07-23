import { parseMaybeJson } from "./dbNormalization.js";

// CI pipeline/job records. A pipeline row owns immutable trigger provenance
// and concurrency bookkeeping; a job row owns the validated spec and the
// GitHub Checks reporter ledger. LIVE execution status is never written here —
// it is the linked canonical run (runs.id), read via joins.

// Pre/non-dispatch job lifecycle. Once phase = dispatched, the linked run's
// status is the single source of truth for how the job is going.
export const CI_JOB_PHASES = ["pending", "dispatched", "skipped", "cancelled"];

export const CI_EXECUTORS = ["native", "dagger"];

// --- pipelines --------------------------------------------------------------

export function normalizeCiPipeline(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoId: row.repo_id,
    runId: row.run_id || null,
    name: row.name,
    trigger: parseMaybeJson(row.trigger, {}),
    configSource: parseMaybeJson(row.config_source, {}),
    tested: parseMaybeJson(row.tested, {}),
    commitSha: row.commit_sha || "",
    concurrencyKey: row.concurrency_key || "",
    supersededBy: row.superseded_by || null,
    checkRunId: row.check_run_id || "",
    checkState: row.check_state || "",
    checkAttempts: row.check_attempts || 0,
    lastCheckError: row.last_check_error || "",
    checkUpdatedAt: row.check_updated_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function ciPipelineCreateRecord({ id, input, timestamp }) {
  return {
    id,
    repo_id: input.repoId,
    run_id: input.runId || null,
    name: input.name || "ci",
    trigger: JSON.stringify(input.trigger || {}),
    config_source: JSON.stringify(input.configSource || {}),
    tested: JSON.stringify(input.tested || {}),
    commit_sha: input.commitSha || "",
    concurrency_key: input.concurrencyKey || "",
    superseded_by: null,
    check_run_id: "",
    check_state: "",
    check_attempts: 0,
    last_check_error: "",
    check_updated_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function ciPipelineInsertQuery() {
  return {
    sql: `INSERT INTO ci_pipelines
     (id, repo_id, run_id, name, trigger, config_source, tested, commit_sha, concurrency_key, superseded_by, check_run_id, check_state, check_attempts, last_check_error, check_updated_at, created_at, updated_at)
     VALUES ($id, $repo_id, $run_id, $name, $trigger, $config_source, $tested, $commit_sha, $concurrency_key, $superseded_by, $check_run_id, $check_state, $check_attempts, $last_check_error, $check_updated_at, $created_at, $updated_at)`
  };
}

export function ciPipelineUpdateCheckQuery({ pipelineId, checkRunId, checkState, checkAttempts, lastCheckError, timestamp }) {
  return {
    sql: `UPDATE ci_pipelines SET check_run_id = ?, check_state = ?, check_attempts = ?,
      last_check_error = ?, check_updated_at = ?, updated_at = ? WHERE id = ?`,
    params: [checkRunId || "", checkState || "", checkAttempts || 0, lastCheckError || "", timestamp, timestamp, pipelineId]
  };
}

export function ciPipelineLookupQuery(pipelineId) {
  return { sql: "SELECT * FROM ci_pipelines WHERE id = ?", params: [pipelineId] };
}

export function ciPipelineByRunLookupQuery(runId) {
  return { sql: "SELECT * FROM ci_pipelines WHERE run_id = ?", params: [runId] };
}

export function ciPipelineListQuery({ repoId = "", limit = 50 } = {}) {
  const where = repoId ? "WHERE repo_id = ?" : "";
  const params = repoId ? [repoId, limit] : [limit];
  return {
    sql: `SELECT * FROM ci_pipelines ${where} ORDER BY created_at DESC LIMIT ?`,
    params
  };
}

// Pipelines whose parent run is still live (join on runs). Used by the
// orchestrator sweep and by cancel-superseded lookups; terminal statuses are
// passed in from runLifecyclePolicy so this module stays SQL-only.
export function ciActivePipelineListQuery({ terminalStatuses, concurrencyKey = "" } = {}) {
  const placeholders = terminalStatuses.map(() => "?").join(", ");
  const keyClause = concurrencyKey ? "AND p.concurrency_key = ?" : "";
  return {
    sql: `SELECT p.* FROM ci_pipelines p
      JOIN runs r ON r.id = p.run_id
      WHERE r.status NOT IN (${placeholders}) ${keyClause}
      ORDER BY p.created_at ASC`,
    params: concurrencyKey ? [...terminalStatuses, concurrencyKey] : [...terminalStatuses]
  };
}

// Pipelines touched since the cutoff — the reporter's scan set (active
// pipelines keep being touched by job/dispatch updates; finished ones fall
// out of the window once their final check state is synced).
export function ciRecentPipelineListQuery({ sinceIso }) {
  return {
    sql: "SELECT * FROM ci_pipelines WHERE updated_at >= ? ORDER BY created_at ASC",
    params: [sinceIso]
  };
}

// Existing child run for a job (restart recovery): a crash between run
// creation and the dispatch mark must adopt the run, never mint a second one.
export function ciJobRunCandidateQuery({ parentRunId, jobId }) {
  return {
    sql: `SELECT * FROM runs WHERE parent_run_id = ?
      AND json_extract(input, '$.__ci.jobId') = ? ORDER BY created_at DESC LIMIT 1`,
    params: [parentRunId, jobId]
  };
}

export function ciLastRunEventAtQuery(runId) {
  return {
    sql: "SELECT MAX(created_at) AS last_event_at FROM run_events WHERE run_id = ?",
    params: [runId]
  };
}

export function ciPipelineSetRunQuery({ pipelineId, runId, timestamp }) {
  return {
    sql: "UPDATE ci_pipelines SET run_id = ?, updated_at = ? WHERE id = ? AND run_id IS NULL",
    params: [runId, timestamp, pipelineId]
  };
}

export function ciPipelineSetSupersededQuery({ pipelineId, supersededBy, timestamp }) {
  return {
    sql: "UPDATE ci_pipelines SET superseded_by = ?, updated_at = ? WHERE id = ?",
    params: [supersededBy, timestamp, pipelineId]
  };
}

export function ciPipelineSetTestedQuery({ pipelineId, tested, timestamp }) {
  return {
    sql: "UPDATE ci_pipelines SET tested = ?, updated_at = ? WHERE id = ?",
    params: [JSON.stringify(tested || {}), timestamp, pipelineId]
  };
}

// --- jobs -------------------------------------------------------------------

export function normalizeCiJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    jobName: row.job_name,
    needs: parseMaybeJson(row.needs, []),
    executor: row.executor,
    spec: parseMaybeJson(row.spec, {}),
    required: Boolean(row.required),
    phase: row.phase,
    phaseReason: row.phase_reason || "",
    runId: row.run_id || null,
    checkRunId: row.check_run_id || "",
    checkState: row.check_state || "",
    checkAttempts: row.check_attempts || 0,
    lastCheckError: row.last_check_error || "",
    checkUpdatedAt: row.check_updated_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function ciJobCreateRecord({ id, pipelineId, input, timestamp }) {
  return {
    id,
    pipeline_id: pipelineId,
    job_name: input.jobName,
    needs: JSON.stringify(input.needs || []),
    executor: CI_EXECUTORS.includes(input.executor) ? input.executor : "native",
    spec: JSON.stringify(input.spec || {}),
    required: input.required === false ? 0 : 1,
    phase: "pending",
    phase_reason: "",
    run_id: null,
    check_run_id: "",
    check_state: "",
    check_attempts: 0,
    last_check_error: "",
    check_updated_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function ciJobInsertQuery() {
  return {
    sql: `INSERT INTO ci_jobs
     (id, pipeline_id, job_name, needs, executor, spec, required, phase, phase_reason, run_id, check_run_id, check_state, check_attempts, last_check_error, check_updated_at, created_at, updated_at)
     VALUES ($id, $pipeline_id, $job_name, $needs, $executor, $spec, $required, $phase, $phase_reason, $run_id, $check_run_id, $check_state, $check_attempts, $last_check_error, $check_updated_at, $created_at, $updated_at)`
  };
}

export function ciJobLookupQuery(jobId) {
  return { sql: "SELECT * FROM ci_jobs WHERE id = ?", params: [jobId] };
}

export function ciJobByRunLookupQuery(runId) {
  return { sql: "SELECT * FROM ci_jobs WHERE run_id = ?", params: [runId] };
}

export function ciJobListQuery(pipelineId) {
  return {
    sql: "SELECT * FROM ci_jobs WHERE pipeline_id = ? ORDER BY created_at ASC, job_name ASC",
    params: [pipelineId]
  };
}

// Guarded dispatch: only a still-pending job may take a run id. The WHERE
// phase = 'pending' makes restart recovery idempotent — a second dispatch
// attempt for the same job is a no-op (changes = 0).
export function ciJobDispatchQuery({ jobId, runId, timestamp }) {
  return {
    sql: "UPDATE ci_jobs SET phase = 'dispatched', run_id = ?, updated_at = ? WHERE id = ? AND phase = 'pending'",
    params: [runId, timestamp, jobId]
  };
}

// Guarded pre-dispatch terminal move (skipped / cancelled): never rewrites a
// dispatched job — its run owns the story from there.
export function ciJobSetPhaseQuery({ jobId, phase, reason, timestamp }) {
  return {
    sql: "UPDATE ci_jobs SET phase = ?, phase_reason = ?, updated_at = ? WHERE id = ? AND phase = 'pending'",
    params: [phase, reason || "", timestamp, jobId]
  };
}

export function ciJobUpdateCheckQuery({ jobId, checkRunId, checkState, checkAttempts, lastCheckError, timestamp }) {
  return {
    sql: `UPDATE ci_jobs SET check_run_id = ?, check_state = ?, check_attempts = ?,
      last_check_error = ?, check_updated_at = ?, updated_at = ? WHERE id = ?`,
    params: [checkRunId || "", checkState || "", checkAttempts || 0, lastCheckError || "", timestamp, timestamp, jobId]
  };
}
