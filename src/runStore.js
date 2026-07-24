import {
  normalizeRun,
  normalizeRunEvent,
  runEventInsertQuery,
  runEventListQuery,
  runEventPageQuery,
  runEventRecord,
  runEventSeqLookupQuery,
  runLookupQuery,
  runOwnerTokenQuery
} from "./runRecords.js";
import {
  capabilityVersionsFromRunsQuery,
  normalizeCapabilityVersionFromRun,
  runCountQuery,
  runListQuery
} from "./runQueryRecords.js";

export function createRunStore({ all, one, run, id, now, visibleRunWhere = "" }) {
  function getRun(runId) {
    const query = runLookupQuery(runId);
    return normalizeRun(one(query.sql, query.params));
  }

  function listRuns({
    status = "",
    limit = 100,
    q = "",
    since = "",
    until = "",
    cursor = "",
    capabilitySlugs = [],
    workItemId = "",
    includeInternal = false
  } = {}) {
    const query = runListQuery({
      status,
      limit,
      q,
      since,
      until,
      cursor,
      capabilitySlugs,
      workItemId,
      includeInternal,
      visibleRunWhere
    });
    return all(query.sql, query.params).map(normalizeRun);
  }

  function countRuns({
    status = "",
    q = "",
    since = "",
    until = "",
    capabilitySlugs = [],
    workItemId = "",
    includeInternal = false
  } = {}) {
    const query = runCountQuery({ status, q, since, until, capabilitySlugs, workItemId, includeInternal, visibleRunWhere });
    return one(query.sql, query.params).count;
  }

  function listCapabilityVersionsFromRuns(slug) {
    if (!slug) return [];
    const query = capabilityVersionsFromRunsQuery(slug);
    return all(query.sql, query.params).map(normalizeCapabilityVersionFromRun);
  }

  function runOwnerTokenId(runId) {
    const query = runOwnerTokenQuery(runId);
    return one(query.sql, query.params)?.token_id || null;
  }

  function addRunEvent(runId, type, message = "", data = {}) {
    const event = runEventRecord({ id: id("evt"), runId, type, message, data, createdAt: now() });
    run(runEventInsertQuery().sql, event);
    // The INSERT assigned the per-run seq atomically; read it back so the
    // returned event (and the SSE bus publish) carries its cursor.
    const seqQuery = runEventSeqLookupQuery(event.id);
    const seqRow = one(seqQuery.sql, seqQuery.params);
    return normalizeRunEvent({ ...event, seq: seqRow?.seq ?? null });
  }

  function listRunEvents(runId) {
    const query = runEventListQuery(runId);
    return all(query.sql, query.params).map(normalizeRunEvent);
  }

  // Bounded cursor page for SSE replay/resume: events with seq > afterSeq in
  // seq order. Mirrors Smithers' adapter.listEvents(runId, afterSeq, limit).
  function listRunEventsAfter(runId, afterSeq = -1, limit = 200) {
    const query = runEventPageQuery({ runId, afterSeq, limit });
    return all(query.sql, query.params).map(normalizeRunEvent);
  }

  return {
    addRunEvent,
    countRuns,
    getRun,
    listCapabilityVersionsFromRuns,
    listRunEvents,
    listRunEventsAfter,
    listRuns,
    runOwnerTokenId
  };
}
