import { boundedInteger, parseMaybeJson } from "./dbNormalization.js";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function normalizeWorkflowEndpoint(row, { includeSecretHash = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    capabilitySlug: row.capability_slug,
    project: row.project,
    repo: row.repo,
    repoDir: row.repo_dir,
    maxPayloadBytes: row.max_payload_bytes,
    rateLimitCount: row.rate_limit_count,
    rateLimitWindowMs: row.rate_limit_window_ms,
    dedupeWindowMs: row.dedupe_window_ms,
    config: parseMaybeJson(row.config, {}),
    enabled: Boolean(row.enabled),
    secretConfigured: Boolean(row.secret_hash),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(includeSecretHash ? { secretHash: row.secret_hash } : {})
  };
}

export function workflowEndpointPayload({ input, existing = null, secretHash, timestamp }) {
  const slug = input.slug;
  return {
    slug,
    name: input.name || slug,
    description: input.description || "",
    secret_hash: secretHash ?? existing?.secret_hash ?? "",
    capability_slug: input.capabilitySlug || input.capability_slug || existing?.capability_slug || "",
    project: input.project || existing?.project || "",
    repo: input.repo || existing?.repo || "",
    repo_dir: input.repoDir || input.repo_dir || existing?.repo_dir || "",
    max_payload_bytes: boundedInteger(input.maxPayloadBytes || input.max_payload_bytes, existing?.max_payload_bytes || 32 * 1024, {
      min: 1024,
      max: 1024 * 1024
    }),
    rate_limit_count: boundedInteger(input.rateLimitCount || input.rate_limit_count, existing?.rate_limit_count || 30, {
      min: 1,
      max: 10_000
    }),
    rate_limit_window_ms: boundedInteger(input.rateLimitWindowMs || input.rate_limit_window_ms, existing?.rate_limit_window_ms || 60_000, {
      min: 1000,
      max: 86_400_000
    }),
    dedupe_window_ms: boundedInteger(input.dedupeWindowMs ?? input.dedupe_window_ms, existing?.dedupe_window_ms || 10 * 60_000, {
      min: 0,
      max: 86_400_000
    }),
    config: jsonField(input.config || parseMaybeJson(existing?.config, {}), {}),
    enabled: input.enabled == null ? (existing?.enabled ?? 1) : input.enabled === false ? 0 : 1,
    updated_at: timestamp
  };
}

export function workflowEndpointSlugQuery(slug) {
  return {
    sql: "SELECT * FROM workflow_endpoints WHERE slug = ?",
    params: [slug]
  };
}

export function workflowEndpointSeedLookupQuery(slug) {
  return {
    sql: "SELECT id FROM workflow_endpoints WHERE slug = ?",
    params: [slug]
  };
}

export function workflowEndpointUpdateQuery(payload) {
  return {
    sql: `UPDATE workflow_endpoints SET name=$name, description=$description, secret_hash=$secret_hash,
       capability_slug=$capability_slug, project=$project, repo=$repo, repo_dir=$repo_dir,
       max_payload_bytes=$max_payload_bytes, rate_limit_count=$rate_limit_count,
       rate_limit_window_ms=$rate_limit_window_ms, dedupe_window_ms=$dedupe_window_ms,
       config=$config, enabled=$enabled, updated_at=$updated_at WHERE slug=$slug`,
    params: payload
  };
}

export function workflowEndpointInsertQuery() {
  return {
    sql: `INSERT INTO workflow_endpoints
       (id, slug, name, description, secret_hash, capability_slug, project, repo, repo_dir,
        max_payload_bytes, rate_limit_count, rate_limit_window_ms, dedupe_window_ms, config,
        enabled, created_at, updated_at)
       VALUES ($id, $slug, $name, $description, $secret_hash, $capability_slug, $project, $repo, $repo_dir,
        $max_payload_bytes, $rate_limit_count, $rate_limit_window_ms, $dedupe_window_ms, $config,
        $enabled, $created_at, $updated_at)`
  };
}

export function workflowEndpointListQuery({ includeDisabled = false } = {}) {
  return includeDisabled
    ? { sql: "SELECT * FROM workflow_endpoints ORDER BY slug", params: [] }
    : { sql: "SELECT * FROM workflow_endpoints WHERE enabled = 1 ORDER BY slug", params: [] };
}

export function workflowEndpointLookupQuery(slugOrId, { includeDisabled = false } = {}) {
  return includeDisabled
    ? { sql: "SELECT * FROM workflow_endpoints WHERE slug = ? OR id = ?", params: [slugOrId, slugOrId] }
    : {
        sql: "SELECT * FROM workflow_endpoints WHERE (slug = ? OR id = ?) AND enabled = 1",
        params: [slugOrId, slugOrId]
      };
}

export function normalizeWorkflowEndpointInvocation(row) {
  if (!row) return null;
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    endpointSlug: row.endpoint_slug,
    payloadHash: row.payload_hash,
    sourceApp: row.source_app,
    sourceUser: row.source_user,
    sourceSession: row.source_session,
    runId: row.run_id,
    status: row.status,
    createdAt: row.created_at
  };
}

export function workflowEndpointInvocationRecord({ id, endpoint, payloadHash, source = {}, runId = null, status = "queued", createdAt }) {
  return {
    id,
    endpoint_id: endpoint.id,
    endpoint_slug: endpoint.slug,
    payload_hash: payloadHash,
    source_app: source.app || "",
    source_user: source.user || "",
    source_session: source.session || "",
    run_id: runId,
    status,
    created_at: createdAt
  };
}

export function workflowEndpointInvocationInsertQuery() {
  return {
    sql: `INSERT INTO workflow_endpoint_invocations
     (id, endpoint_id, endpoint_slug, payload_hash, source_app, source_user, source_session, run_id, status, created_at)
     VALUES ($id, $endpoint_id, $endpoint_slug, $payload_hash, $source_app, $source_user, $source_session, $run_id, $status, $created_at)`
  };
}

export function workflowEndpointInvocationCountQuery(endpointId, sinceIso) {
  return {
    sql: "SELECT COUNT(*) AS count FROM workflow_endpoint_invocations WHERE endpoint_id = ? AND created_at >= ?",
    params: [endpointId, sinceIso]
  };
}

export function workflowEndpointRecentInvocationQuery(endpointId, payloadHash, sinceIso) {
  return {
    sql: `SELECT * FROM workflow_endpoint_invocations
      WHERE endpoint_id = ? AND payload_hash = ? AND created_at >= ? AND run_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    params: [endpointId, payloadHash, sinceIso]
  };
}
