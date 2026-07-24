import { RUN_TERMINAL } from "./runLifecyclePolicy.js";
import { normalizeRun } from "./runRecords.js";
import {
  ciActivePipelineListQuery,
  ciJobRunCandidateQuery,
  ciLastRunEventAtQuery,
  ciPipelineUpdateCheckQuery,
  ciRecentPipelineListQuery,
  ciJobByRunLookupQuery,
  ciJobCreateRecord,
  ciJobDispatchQuery,
  ciJobInsertQuery,
  ciJobListQuery,
  ciJobLookupQuery,
  ciJobSetPhaseQuery,
  ciJobUpdateCheckQuery,
  ciPipelineByRunLookupQuery,
  ciPipelineCreateRecord,
  ciPipelineInsertQuery,
  ciPipelineListQuery,
  ciPipelineLookupQuery,
  ciOrphanPipelineListQuery,
  ciPipelineSetRunQuery,
  ciPipelineSetSupersededQuery,
  ciPipelineTouchQuery,
  normalizeCiJob,
  normalizeCiPipeline
} from "./ciRecords.js";

// CI pipeline/job store. Live status stays on the canonical runs rows; this
// store owns provenance, DAG bookkeeping, and the checks-reporter ledger.

const TERMINAL_STATUSES = [...RUN_TERMINAL];

export function createCiStore({ all, one, run, id, now }) {
  function getCiPipeline(pipelineId) {
    const query = ciPipelineLookupQuery(pipelineId);
    return normalizeCiPipeline(one(query.sql, query.params));
  }

  function getCiPipelineByRunId(runId) {
    const query = ciPipelineByRunLookupQuery(runId);
    return normalizeCiPipeline(one(query.sql, query.params));
  }

  function listCiPipelines(options = {}) {
    const query = ciPipelineListQuery(options);
    return all(query.sql, query.params).map(normalizeCiPipeline);
  }

  function listActiveCiPipelines({ concurrencyKey = "" } = {}) {
    const query = ciActivePipelineListQuery({ terminalStatuses: TERMINAL_STATUSES, concurrencyKey });
    return all(query.sql, query.params).map(normalizeCiPipeline);
  }

  function createCiPipeline(input) {
    const record = ciPipelineCreateRecord({ id: id("cipipe"), input, timestamp: now() });
    run(ciPipelineInsertQuery().sql, record);
    for (const job of input.jobs || []) {
      const jobRecord = ciJobCreateRecord({ id: id("cijob"), pipelineId: record.id, input: job, timestamp: now() });
      run(ciJobInsertQuery().sql, jobRecord);
    }
    return getCiPipeline(record.id);
  }

  function listRecentCiPipelines({ sinceIso }) {
    const query = ciRecentPipelineListQuery({ sinceIso });
    return all(query.sql, query.params).map(normalizeCiPipeline);
  }

  function findCiJobRunCandidate(parentRunId, jobId) {
    const query = ciJobRunCandidateQuery({ parentRunId, jobId });
    return normalizeRun(one(query.sql, query.params));
  }

  function lastCiRunEventAt(runId) {
    const query = ciLastRunEventAtQuery(runId);
    return one(query.sql, query.params)?.last_event_at || null;
  }

  function updateCiPipelineCheck(pipelineId, { checkRunId, checkState, checkAttempts, checkAttemptsFor, lastCheckError } = {}) {
    const existing = getCiPipeline(pipelineId);
    if (!existing) return null;
    const query = ciPipelineUpdateCheckQuery({
      pipelineId,
      checkRunId: checkRunId != null ? checkRunId : existing.checkRunId,
      checkState: checkState != null ? checkState : existing.checkState,
      checkAttempts: checkAttempts != null ? checkAttempts : existing.checkAttempts,
      checkAttemptsFor: checkAttemptsFor != null ? checkAttemptsFor : existing.checkAttemptsFor,
      lastCheckError: lastCheckError != null ? lastCheckError : existing.lastCheckError,
      timestamp: now()
    });
    run(query.sql, query.params);
    return getCiPipeline(pipelineId);
  }

  function setCiPipelineRun(pipelineId, runId) {
    const query = ciPipelineSetRunQuery({ pipelineId, runId, timestamp: now() });
    run(query.sql, query.params);
    return getCiPipeline(pipelineId);
  }

  function markCiPipelineSuperseded(pipelineId, supersededBy) {
    const query = ciPipelineSetSupersededQuery({ pipelineId, supersededBy, timestamp: now() });
    run(query.sql, query.params);
    return getCiPipeline(pipelineId);
  }

  function listOrphanCiPipelines({ olderThanIso }) {
    const query = ciOrphanPipelineListQuery({ olderThanIso });
    return all(query.sql, query.params).map(normalizeCiPipeline);
  }

  function touchCiPipeline(pipelineId) {
    const query = ciPipelineTouchQuery({ pipelineId, timestamp: now() });
    run(query.sql, query.params);
    return getCiPipeline(pipelineId);
  }

  function getCiJob(jobId) {
    const query = ciJobLookupQuery(jobId);
    return normalizeCiJob(one(query.sql, query.params));
  }

  function getCiJobByRunId(runId) {
    const query = ciJobByRunLookupQuery(runId);
    return normalizeCiJob(one(query.sql, query.params));
  }

  function listCiJobs(pipelineId) {
    const query = ciJobListQuery(pipelineId);
    return all(query.sql, query.params).map(normalizeCiJob);
  }

  // Returns the updated job only when THIS call performed the dispatch; a
  // lost race / restart replay returns null so the caller never double-runs.
  function markCiJobDispatched(jobId, runId) {
    const query = ciJobDispatchQuery({ jobId, runId, timestamp: now() });
    const result = run(query.sql, query.params);
    return result.changes ? getCiJob(jobId) : null;
  }

  function markCiJobPhase(jobId, phase, reason = "") {
    const query = ciJobSetPhaseQuery({ jobId, phase, reason, timestamp: now() });
    const result = run(query.sql, query.params);
    return result.changes ? getCiJob(jobId) : null;
  }

  function updateCiJobCheck(jobId, { checkRunId, checkState, checkAttempts, checkAttemptsFor, lastCheckError } = {}) {
    const existing = getCiJob(jobId);
    if (!existing) return null;
    const query = ciJobUpdateCheckQuery({
      jobId,
      checkRunId: checkRunId != null ? checkRunId : existing.checkRunId,
      checkState: checkState != null ? checkState : existing.checkState,
      checkAttempts: checkAttempts != null ? checkAttempts : existing.checkAttempts,
      checkAttemptsFor: checkAttemptsFor != null ? checkAttemptsFor : existing.checkAttemptsFor,
      lastCheckError: lastCheckError != null ? lastCheckError : existing.lastCheckError,
      timestamp: now()
    });
    run(query.sql, query.params);
    return getCiJob(jobId);
  }

  return {
    createCiPipeline,
    findCiJobRunCandidate,
    getCiJob,
    getCiJobByRunId,
    getCiPipeline,
    getCiPipelineByRunId,
    lastCiRunEventAt,
    listActiveCiPipelines,
    listCiJobs,
    listCiPipelines,
    listRecentCiPipelines,
    markCiJobDispatched,
    markCiJobPhase,
    listOrphanCiPipelines,
    markCiPipelineSuperseded,
    setCiPipelineRun,
    touchCiPipeline,
    updateCiJobCheck,
    updateCiPipelineCheck
  };
}
