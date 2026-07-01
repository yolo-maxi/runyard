import { parseMaybeJson } from "./dbNormalization.js";
import {
  activeSupervisorRunsQuery,
  normalizeRun,
  normalizeRunEvent,
  runEventInsertQuery,
  runEventListQuery,
  runEventRecord,
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

  function findActiveSupervisorByToken(token, wrappedCapability = "") {
    const clean = String(token || "").trim();
    if (!clean) return null;
    const query = activeSupervisorRunsQuery();
    for (const row of all(query.sql, query.params)) {
      const input = parseMaybeJson(row.input, {});
      if (input?.__supervisionToken !== clean) continue;
      if (wrappedCapability && input?.wrappedCapability !== wrappedCapability) continue;
      return normalizeRun(row);
    }
    return null;
  }

  function listRuns({
    status = "",
    limit = 100,
    q = "",
    since = "",
    until = "",
    cursor = "",
    capabilitySlugs = [],
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
    includeInternal = false
  } = {}) {
    const query = runCountQuery({ status, q, since, until, capabilitySlugs, includeInternal, visibleRunWhere });
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
    return normalizeRunEvent(event);
  }

  function listRunEvents(runId) {
    const query = runEventListQuery(runId);
    return all(query.sql, query.params).map(normalizeRunEvent);
  }

  return {
    addRunEvent,
    countRuns,
    findActiveSupervisorByToken,
    getRun,
    listCapabilityVersionsFromRuns,
    listRunEvents,
    listRuns,
    runOwnerTokenId
  };
}
