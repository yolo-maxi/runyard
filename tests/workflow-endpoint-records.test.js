import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
  workflowEndpointSeedLookupQuery,
  workflowEndpointSlugQuery,
  workflowEndpointUpdateQuery
} from "../src/workflowEndpointRecords.js";

describe("workflow endpoint record helpers", () => {
  it("normalizes endpoint rows without exposing the secret hash by default", () => {
    const row = {
      id: "wend_1",
      slug: "feedback",
      name: "Feedback",
      description: "Trusted feedback",
      secret_hash: "hash_1",
      capability_slug: "improve",
      project: "runyard",
      repo: "runyard",
      repo_dir: "apps/web",
      max_payload_bytes: 32000,
      rate_limit_count: 10,
      rate_limit_window_ms: 60000,
      dedupe_window_ms: 300000,
      config: '{"target":"mobile"}',
      enabled: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z"
    };

    const endpoint = normalizeWorkflowEndpoint(row);
    assert.equal(endpoint.slug, "feedback");
    assert.equal(endpoint.capabilitySlug, "improve");
    assert.deepEqual(endpoint.config, { target: "mobile" });
    assert.equal(endpoint.secretConfigured, true);
    assert.equal("secretHash" in endpoint, false);

    assert.equal(normalizeWorkflowEndpoint(row, { includeSecretHash: true }).secretHash, "hash_1");
  });

  it("builds bounded endpoint payloads from input plus existing defaults", () => {
    const payload = workflowEndpointPayload({
      input: {
        slug: "feedback",
        capabilitySlug: "improve",
        maxPayloadBytes: 5,
        rateLimitCount: 0,
        rateLimitWindowMs: 100,
        dedupeWindowMs: 0,
        config: { target: "app" },
        enabled: false
      },
      existing: {
        secret_hash: "existing_hash",
        max_payload_bytes: 65536,
        rate_limit_count: 20,
        rate_limit_window_ms: 120000,
        dedupe_window_ms: 600000,
        enabled: 1,
        config: '{"target":"old"}'
      },
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(payload.name, "feedback");
    assert.equal(payload.secret_hash, "existing_hash");
    assert.equal(payload.max_payload_bytes, 1024);
    assert.equal(payload.rate_limit_count, 20);
    assert.equal(payload.rate_limit_window_ms, 1000);
    assert.equal(payload.dedupe_window_ms, 0);
    assert.equal(payload.config, '{"target":"app"}');
    assert.equal(payload.enabled, 0);
  });

  it("normalizes workflow endpoint invocation records", () => {
    const record = workflowEndpointInvocationRecord({
      id: "weni_1",
      endpoint: { id: "wend_1", slug: "feedback" },
      payloadHash: "hash",
      source: { app: "mobile", user: "ada", session: "s1" },
      runId: "run_1",
      status: "queued",
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(normalizeWorkflowEndpointInvocation(record), {
      id: "weni_1",
      endpointId: "wend_1",
      endpointSlug: "feedback",
      payloadHash: "hash",
      sourceApp: "mobile",
      sourceUser: "ada",
      sourceSession: "s1",
      runId: "run_1",
      status: "queued",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
  });

  it("builds endpoint list and lookup queries", () => {
    assert.deepEqual(workflowEndpointListQuery(), {
      sql: "SELECT * FROM workflow_endpoints WHERE enabled = 1 ORDER BY slug",
      params: []
    });
    assert.deepEqual(workflowEndpointListQuery({ includeDisabled: true }), {
      sql: "SELECT * FROM workflow_endpoints ORDER BY slug",
      params: []
    });
    assert.deepEqual(workflowEndpointLookupQuery("feedback"), {
      sql: "SELECT * FROM workflow_endpoints WHERE (slug = ? OR id = ?) AND enabled = 1",
      params: ["feedback", "feedback"]
    });
    assert.deepEqual(workflowEndpointLookupQuery("feedback", { includeDisabled: true }), {
      sql: "SELECT * FROM workflow_endpoints WHERE slug = ? OR id = ?",
      params: ["feedback", "feedback"]
    });
    assert.deepEqual(workflowEndpointSlugQuery("feedback"), {
      sql: "SELECT * FROM workflow_endpoints WHERE slug = ?",
      params: ["feedback"]
    });
    assert.deepEqual(workflowEndpointSeedLookupQuery("feedback"), {
      sql: "SELECT id FROM workflow_endpoints WHERE slug = ?",
      params: ["feedback"]
    });
  });

  it("builds endpoint upsert queries", () => {
    const payload = workflowEndpointPayload({
      input: { slug: "feedback", capabilitySlug: "improve" },
      secretHash: "hash",
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(workflowEndpointUpdateQuery(payload), {
      sql: `UPDATE workflow_endpoints SET name=$name, description=$description, secret_hash=$secret_hash,
       capability_slug=$capability_slug, project=$project, repo=$repo, repo_dir=$repo_dir,
       max_payload_bytes=$max_payload_bytes, rate_limit_count=$rate_limit_count,
       rate_limit_window_ms=$rate_limit_window_ms, dedupe_window_ms=$dedupe_window_ms,
       config=$config, enabled=$enabled, updated_at=$updated_at WHERE slug=$slug`,
      params: payload
    });
    assert.deepEqual(workflowEndpointInsertQuery(), {
      sql: `INSERT INTO workflow_endpoints
       (id, slug, name, description, secret_hash, capability_slug, project, repo, repo_dir,
        max_payload_bytes, rate_limit_count, rate_limit_window_ms, dedupe_window_ms, config,
        enabled, created_at, updated_at)
       VALUES ($id, $slug, $name, $description, $secret_hash, $capability_slug, $project, $repo, $repo_dir,
        $max_payload_bytes, $rate_limit_count, $rate_limit_window_ms, $dedupe_window_ms, $config,
        $enabled, $created_at, $updated_at)`
    });
  });

  it("builds endpoint invocation queries", () => {
    assert.deepEqual(workflowEndpointInvocationCountQuery("wend_1", "2026-01-01T00:00:00.000Z"), {
      sql: "SELECT COUNT(*) AS count FROM workflow_endpoint_invocations WHERE endpoint_id = ? AND created_at >= ?",
      params: ["wend_1", "2026-01-01T00:00:00.000Z"]
    });
    assert.deepEqual(workflowEndpointRecentInvocationQuery("wend_1", "hash", "2026-01-01T00:00:00.000Z"), {
      sql: `SELECT * FROM workflow_endpoint_invocations
      WHERE endpoint_id = ? AND payload_hash = ? AND created_at >= ? AND run_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
      params: ["wend_1", "hash", "2026-01-01T00:00:00.000Z"]
    });
    assert.deepEqual(workflowEndpointInvocationInsertQuery(), {
      sql: `INSERT INTO workflow_endpoint_invocations
     (id, endpoint_id, endpoint_slug, payload_hash, source_app, source_user, source_session, run_id, status, created_at)
     VALUES ($id, $endpoint_id, $endpoint_slug, $payload_hash, $source_app, $source_user, $source_session, $run_id, $status, $created_at)`
    });
  });
});
