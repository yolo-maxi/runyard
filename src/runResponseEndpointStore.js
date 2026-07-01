import {
  normalizeRunResponseEndpoint,
  pendingRunResponseEndpointsQuery,
  runResponseEndpointDeliveryUpdateQuery,
  runResponseEndpointsForRunQuery,
  runResponseEndpointInsertQuery,
  runResponseEndpointLookupQuery,
  runResponseEndpointRecord
} from "./runResponseEndpointRecords.js";

export function createRunResponseEndpointStore({ all, one, run, id, now }) {
  function getRunResponseEndpoint(endpointId) {
    const query = runResponseEndpointLookupQuery(endpointId);
    return normalizeRunResponseEndpoint(one(query.sql, query.params));
  }

  function createRunResponseEndpoint({ runId, type, config, createdBy = "" }) {
    const timestamp = now();
    const record = runResponseEndpointRecord({ id: id("rres"), runId, type, config, createdBy, timestamp });
    const insert = runResponseEndpointInsertQuery();
    run(insert.sql, record);
    return getRunResponseEndpoint(record.id);
  }

  function listRunResponseEndpointsForRun(runId) {
    if (!runId) return [];
    const query = runResponseEndpointsForRunQuery(runId);
    return all(query.sql, query.params).map(normalizeRunResponseEndpoint);
  }

  function listPendingRunResponseEndpoints(limit = 100) {
    const query = pendingRunResponseEndpointsQuery(limit);
    return all(query.sql, query.params).map(normalizeRunResponseEndpoint);
  }

  function updateRunResponseEndpointDelivery(endpointId, updates = {}) {
    const query = runResponseEndpointDeliveryUpdateQuery({ id: endpointId, updates, timestamp: now() });
    run(query.sql, query.params);
    return getRunResponseEndpoint(endpointId);
  }

  return {
    createRunResponseEndpoint,
    listPendingRunResponseEndpoints,
    listRunResponseEndpointsForRun,
    updateRunResponseEndpointDelivery
  };
}
