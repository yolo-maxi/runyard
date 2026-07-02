import {
  normalizeRunner,
  runnerActiveRunsAdjustmentQuery,
  runnerActiveRunsReconcileQuery,
  runnerActiveRunsSetQuery,
  runnerDeleteQuery,
  runnerHeartbeatParams,
  runnerHeartbeatUpdateQuery,
  runnerIsLive as runnerHeartbeatIsLive,
  runnerListQuery,
  runnerLoadQuery,
  runnerOwnedLookupQuery,
  runnerOwnerTokenQuery,
  runnerRegistrationInsertQuery,
  runnerRegistrationPayload,
  runnerRegistrationUpdateQuery,
  runnerStableIdentityLookupQuery,
  staleRunnerListQuery
} from "./runnerRecords.js";
import { supervisorPoolSizeForCapacity } from "./runnerPoolPolicy.js";

export function createRunnerStore({
  all,
  one,
  run,
  id,
  now,
  runnerOfflineMs,
  runnerPruneMs,
  supervisorCapabilitySlug,
  supervisorSlotRatio
}) {
  function runnerIsLive(lastHeartbeatAt) {
    return runnerHeartbeatIsLive(lastHeartbeatAt, runnerOfflineMs);
  }

  function runnerLoad(runnerId) {
    if (!runnerId) return { work: 0, supervisors: 0 };
    const query = runnerLoadQuery({ runnerId, supervisorCapabilitySlug });
    const row = one(query.sql, query.params);
    return { work: Number(row?.work) || 0, supervisors: Number(row?.supervisors) || 0 };
  }

  function getRunner(runnerId) {
    const query = runnerOwnedLookupQuery(runnerId);
    const row = one(query.sql, query.params);
    if (!row) return null;
    const live = runnerIsLive(row.last_heartbeat_at);
    const load = runnerLoad(row.id);
    return normalizeRunner(row, { live, load });
  }

  function runnerOwnerTokenId(runnerId) {
    const query = runnerOwnerTokenQuery(runnerId);
    return one(query.sql, query.params)?.token_id || null;
  }

  function registerRunner(input, tokenId = null) {
    // Only reuse a supplied runner id when the caller's token owns it; otherwise
    // a runner token could hijack another runner by guessing its id.
    const candidateQuery = input.id ? runnerOwnedLookupQuery(input.id) : null;
    const candidate = candidateQuery ? one(candidateQuery.sql, candidateQuery.params) : null;
    let existing = candidate && candidate.token_id && candidate.token_id === tokenId ? candidate : null;

    // Stable-identity fallback prevents ghost rows after a runner loses its
    // cached id. The token_id match preserves ownership across same host/name.
    if (!existing && tokenId) {
      const name = input.name || input.hostname || "runner";
      const hostname = input.hostname || "";
      const query = runnerStableIdentityLookupQuery({ tokenId, name, hostname });
      existing = one(query.sql, query.params);
    }

    const payload = runnerRegistrationPayload({
      input,
      existing,
      id: id("runner"),
      tokenId,
      timestamp: now()
    });
    if (existing) {
      const query = runnerRegistrationUpdateQuery(payload);
      run(query.sql, query.params);
    } else {
      const query = runnerRegistrationInsertQuery();
      run(query.sql, payload);
    }
    return getRunner(payload.id);
  }

  function listRunners() {
    const query = runnerListQuery();
    return all(query.sql, query.params).map((row) => getRunner(row.id));
  }

  function heartbeatRunner(runnerId, input = {}) {
    const query = runnerHeartbeatUpdateQuery(runnerHeartbeatParams({ input, timestamp: now(), runnerId }));
    run(query.sql, query.params);
    return getRunner(runnerId);
  }

  function pruneDeadRunners(maxMs = runnerPruneMs) {
    if (!maxMs || maxMs <= 0) return [];
    const query = staleRunnerListQuery(Math.floor(maxMs / 1000));
    const ids = all(query.sql, query.params).map((row) => row.id);
    for (const runnerId of ids) {
      const deleteQuery = runnerDeleteQuery(runnerId);
      run(deleteQuery.sql, deleteQuery.params);
    }
    return ids;
  }

  function adjustRunnerActiveRuns(runnerId, delta) {
    if (!runnerId) return;
    const query = runnerActiveRunsAdjustmentQuery({ runnerId, delta });
    run(query.sql, query.params);
  }

  function supervisorPoolSize(capacity) {
    return supervisorPoolSizeForCapacity(capacity, supervisorSlotRatio);
  }

  function reconcileRunnerActiveRuns() {
    const query = runnerActiveRunsReconcileQuery();
    const corrected = [];
    for (const row of all(query.sql, query.params)) {
      const actual = Number(row.actual) || 0;
      const hasStaleCurrentRun = actual <= 0 && row.current_run_id;
      if (Number(row.stored) === actual && !hasStaleCurrentRun) continue;
      const update = runnerActiveRunsSetQuery({ runnerId: row.id, activeRuns: row.actual });
      run(update.sql, update.params);
      corrected.push({ id: row.id, from: Number(row.stored), to: actual, clearedCurrentRunId: Boolean(hasStaleCurrentRun) });
    }
    return corrected;
  }

  return {
    adjustRunnerActiveRuns,
    getRunner,
    heartbeatRunner,
    listRunners,
    pruneDeadRunners,
    reconcileRunnerActiveRuns,
    registerRunner,
    runnerIsLive,
    runnerLoad,
    runnerOwnerTokenId,
    supervisorPoolSize
  };
}
