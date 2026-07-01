import {
  normalizeWorkflowEndpoint,
  normalizeWorkflowEndpointInvocation,
  workflowEndpointInvocationCountQuery,
  workflowEndpointInvocationInsertQuery,
  workflowEndpointInvocationRecord,
  workflowEndpointInsertQuery,
  workflowEndpointListQuery,
  workflowEndpointLookupQuery,
  workflowEndpointPayload,
  workflowEndpointRecentInvocationQuery,
  workflowEndpointSlugQuery,
  workflowEndpointUpdateQuery
} from "./workflowEndpointRecords.js";

export function createWorkflowEndpointStore({ all, one, run, id, now, hashToken }) {
  function listWorkflowEndpoints({ includeDisabled = false } = {}) {
    const query = workflowEndpointListQuery({ includeDisabled });
    return all(query.sql, query.params).map((row) => normalizeWorkflowEndpoint(row));
  }

  function getWorkflowEndpoint(slugOrId, { includeSecretHash = false, includeDisabled = false } = {}) {
    const query = workflowEndpointLookupQuery(slugOrId, { includeDisabled });
    return normalizeWorkflowEndpoint(one(query.sql, query.params), { includeSecretHash });
  }

  function upsertWorkflowEndpoint(input, options = {}) {
    const slug = input.slug;
    if (!slug) throw new Error("workflow endpoint slug is required");
    const existingQuery = workflowEndpointSlugQuery(slug);
    const existing = one(existingQuery.sql, existingQuery.params);
    if (!existing && !options.secret) throw new Error("workflow endpoint secret is required for new endpoints");
    const timestamp = now();
    const payload = workflowEndpointPayload({
      input,
      existing,
      secretHash: options.secret ? hashToken(options.secret) : undefined,
      timestamp
    });
    if (existing) {
      const query = workflowEndpointUpdateQuery(payload);
      run(query.sql, query.params);
    } else {
      const query = workflowEndpointInsertQuery();
      run(query.sql, { id: id("wend"), created_at: timestamp, ...payload });
    }
    return getWorkflowEndpoint(slug, { includeDisabled: true });
  }

  function countWorkflowEndpointInvocations(endpointId, sinceIso) {
    const query = workflowEndpointInvocationCountQuery(endpointId, sinceIso);
    return one(query.sql, query.params).count;
  }

  function findRecentWorkflowEndpointInvocation(endpointId, payloadHash, sinceIso) {
    const query = workflowEndpointRecentInvocationQuery(endpointId, payloadHash, sinceIso);
    const row = one(query.sql, query.params);
    if (!row) return null;
    return normalizeWorkflowEndpointInvocation(row);
  }

  function recordWorkflowEndpointInvocation({ endpoint, payloadHash, source = {}, runId = null, status = "queued" }) {
    const record = workflowEndpointInvocationRecord({
      id: id("weni"),
      endpoint,
      payloadHash,
      source,
      runId,
      status,
      createdAt: now()
    });
    const query = workflowEndpointInvocationInsertQuery();
    run(query.sql, record);
    return normalizeWorkflowEndpointInvocation(record);
  }

  return {
    countWorkflowEndpointInvocations,
    findRecentWorkflowEndpointInvocation,
    getWorkflowEndpoint,
    listWorkflowEndpoints,
    recordWorkflowEndpointInvocation,
    upsertWorkflowEndpoint
  };
}
