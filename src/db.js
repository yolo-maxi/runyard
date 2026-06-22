import { existsSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env.js";
import { id, now } from "./ids.js";
import {
  executionIntentFromInput,
  executionIntentMatchesRunnerTags,
  normalizeExecutionIntent,
  storeExecutionIntent
} from "./runExecution.js";
import { hashToken, randomToken } from "./security.js";
import { seedAgents, seedCapabilities, seedKnowledge, seedSkills } from "./seeds.js";

export const db = new DatabaseSync(env.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

function json(value, fallback = null) {
  if (value === undefined) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

export function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function one(sql, params = {}) {
  return Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params);
}

function all(sql, params = {}) {
  return Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params);
}

function run(sql, params = {}) {
  return Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params);
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]',
      skill_slugs TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_resources (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'doc',
      body TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS capabilities (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      keywords TEXT NOT NULL DEFAULT '[]',
      input_schema TEXT NOT NULL DEFAULT '{}',
      output_schema TEXT NOT NULL DEFAULT '{}',
      required_runner_tags TEXT NOT NULL DEFAULT '[]',
      required_skills TEXT NOT NULL DEFAULT '[]',
      required_agents TEXT NOT NULL DEFAULT '[]',
      approval_policy TEXT NOT NULL DEFAULT '{}',
      supervision TEXT NOT NULL DEFAULT '{}',
      workflow TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS capability_versions (
      id TEXT PRIMARY KEY,
      capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'offline',
      current_run_id TEXT,
      token_id TEXT,
      capacity INTEGER NOT NULL DEFAULT 1,
      active_runs INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_heartbeat_at TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      capability_id TEXT NOT NULL REFERENCES capabilities(id),
      capability_slug TEXT NOT NULL,
      capability_name TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      runner_id TEXT,
      status TEXT NOT NULL,
      current_step TEXT NOT NULL DEFAULT '',
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      assigned_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'file',
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT 'workflow',
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      decision TEXT,
      comment TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_endpoints (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      secret_hash TEXT NOT NULL,
      capability_slug TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      repo TEXT NOT NULL DEFAULT '',
      repo_dir TEXT NOT NULL DEFAULT '',
      max_payload_bytes INTEGER NOT NULL DEFAULT 32768,
      rate_limit_count INTEGER NOT NULL DEFAULT 30,
      rate_limit_window_ms INTEGER NOT NULL DEFAULT 60000,
      dedupe_window_ms INTEGER NOT NULL DEFAULT 600000,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_response_endpoints (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      delivered_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_endpoint_invocations (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL REFERENCES workflow_endpoints(id) ON DELETE CASCADE,
      endpoint_slug TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      source_app TEXT NOT NULL DEFAULT '',
      source_user TEXT NOT NULL DEFAULT '',
      source_session TEXT NOT NULL DEFAULT '',
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_workflow_endpoint_invocations_payload ON workflow_endpoint_invocations(endpoint_id, payload_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_endpoint_invocations_endpoint ON workflow_endpoint_invocations(endpoint_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_run_response_endpoints_run ON run_response_endpoints(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_response_endpoints_status ON run_response_endpoints(delivery_status);
  `);

  migrateRunnersPoolColumns();
  migrateCapabilitySupervisionColumn();
  setSettingDefault("instance_name", env.instanceName);
  seedAll();
  seedWorkflowEndpoints();
  autoQueueLegacyRunStartApprovals();
  ensureBootstrapToken();
}

// Capacity / active_runs were added after the initial schema shipped. Existing
// installs may already have a runners table without these columns — the CREATE
// TABLE IF NOT EXISTS above is a no-op there, so we add the columns manually.
function migrateRunnersPoolColumns() {
  const columns = all("PRAGMA table_info(runners)").map((row) => row.name);
  if (!columns.includes("capacity")) {
    db.exec("ALTER TABLE runners ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.includes("active_runs")) {
    db.exec("ALTER TABLE runners ADD COLUMN active_runs INTEGER NOT NULL DEFAULT 0");
  }
}

// `supervision` (the default-supervision-envelope flag) shipped after the
// initial capabilities schema. Add the column on existing installs so seeding
// can populate it; the CREATE TABLE above is a no-op when the table exists.
function migrateCapabilitySupervisionColumn() {
  const columns = all("PRAGMA table_info(capabilities)").map((row) => row.name);
  if (!columns.includes("supervision")) {
    db.exec("ALTER TABLE capabilities ADD COLUMN supervision TEXT NOT NULL DEFAULT '{}'");
  }
}

function setSettingDefault(key, value) {
  const existing = one("SELECT key FROM settings WHERE key = ?", [key]);
  if (!existing) {
    run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)", [key, String(value), now()]);
  }
}

function ensureBootstrapToken() {
  const count = one("SELECT COUNT(*) AS count FROM access_tokens").count;
  if (count > 0) return;
  const token = env.bootstrapToken || randomToken();
  createAccessToken("bootstrap-admin", token, ["admin", "api", "runner", "mcp"]);
  const tokenFile = path.join(env.dataDir, "bootstrap-token.txt");
  if (!existsSync(tokenFile)) {
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
  }
  console.log(`Smithers Hub bootstrap token written to ${tokenFile}`);
}

export function createAccessToken(name, token = randomToken(), scopes = ["api"], options = {}) {
  const record = {
    id: id("tok"),
    name,
    token_hash: hashToken(token),
    scopes: json(scopes, []),
    created_at: now(),
    expires_at: options.expiresAt || null
  };
  run(
    "INSERT INTO access_tokens (id, name, token_hash, scopes, created_at, expires_at) VALUES ($id, $name, $token_hash, $scopes, $created_at, $expires_at)",
    record
  );
  return { id: record.id, name, token, scopes, createdAt: record.created_at, expiresAt: record.expires_at };
}

function normalizeToken(row) {
  if (!row) return null;
  const expired = Boolean(row.expires_at && row.expires_at <= now());
  return {
    id: row.id,
    name: row.name,
    scopes: parseJson(row.scopes, []),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    active: !row.revoked_at && !expired
  };
}

export function listAccessTokens() {
  return all(
    "SELECT id, name, scopes, created_at, last_used_at, revoked_at, expires_at FROM access_tokens ORDER BY created_at DESC"
  ).map(normalizeToken);
}

export function getAccessToken(tokenId) {
  return normalizeToken(one("SELECT * FROM access_tokens WHERE id = ?", [tokenId]));
}

export function revokeAccessToken(tokenId) {
  const existing = one("SELECT id, revoked_at FROM access_tokens WHERE id = ?", [tokenId]);
  if (!existing) return null;
  if (!existing.revoked_at) run("UPDATE access_tokens SET revoked_at = ? WHERE id = ?", [now(), tokenId]);
  return getAccessToken(tokenId);
}

export function authenticateToken(token) {
  if (!token) return null;
  const record = one(
    "SELECT * FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    [hashToken(token), now()]
  );
  if (!record) return null;
  run("UPDATE access_tokens SET last_used_at = ? WHERE id = ?", [now(), record.id]);
  return { ...record, scopes: parseJson(record.scopes, []) };
}

function seedAll() {
  for (const skill of seedSkills) upsertSkill(skill);
  for (const agent of seedAgents) upsertAgent(agent);
  for (const item of seedKnowledge) upsertKnowledge(item);
  for (const capability of seedCapabilities) upsertCapability(capability);
}

const seededWorkflowEndpoints = [
  {
    slug: "runyard-mobile-feedback",
    name: "Runyard mobile/app feedback",
    description: "Accepts trusted app-server feedback submissions and queues a constrained improve-no-deploy run for Runyard.",
    capabilitySlug: "improve-no-deploy",
    project: "runyard",
    repo: "smithers-hub",
    maxPayloadBytes: 32 * 1024,
    rateLimitCount: 30,
    rateLimitWindowMs: 60_000,
    dedupeWindowMs: 10 * 60_000,
    config: {
      target: "Runyard mobile/app feedback",
      maxImprovements: 3,
      untrustedInput: true
    }
  }
];

function endpointSecretPath(slug) {
  return path.join(env.dataDir, "workflow-endpoints", `${slug}-secret.txt`);
}

function readOrCreateSeededEndpointSecret(slug) {
  const file = endpointSecretPath(slug);
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value) return value;
  }
  const token = randomToken();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  console.log(`Runyard workflow endpoint secret written to ${file}`);
  return token;
}

function seedWorkflowEndpoints() {
  for (const endpoint of seededWorkflowEndpoints) {
    const existing = one("SELECT id FROM workflow_endpoints WHERE slug = ?", [endpoint.slug]);
    const secret = env.runyardMobileFeedbackEndpointSecret || (existing ? "" : readOrCreateSeededEndpointSecret(endpoint.slug));
    upsertWorkflowEndpoint(endpoint, secret ? { secret } : {});
  }
}

export function normalizeCapability(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    keywords: parseJson(row.keywords, []),
    inputSchema: parseJson(row.input_schema, {}),
    outputSchema: parseJson(row.output_schema, {}),
    requiredRunnerTags: parseJson(row.required_runner_tags, []),
    requiredSkills: parseJson(row.required_skills, []),
    requiredAgents: parseJson(row.required_agents, []),
    approvalPolicy: parseJson(row.approval_policy, {}),
    supervision: parseJson(row.supervision, {}),
    workflow: parseJson(row.workflow, {}),
    version: row.version,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listCapabilities({ q = "", includeDisabled = false } = {}) {
  const like = `%${q}%`;
  const enabledClause = includeDisabled ? "" : "enabled = 1";
  const searchClause = q ? "(name LIKE ? OR slug LIKE ? OR description LIKE ? OR keywords LIKE ?)" : "";
  const where = [enabledClause, searchClause].filter(Boolean).join(" AND ");
  const sql = `SELECT * FROM capabilities ${where ? `WHERE ${where}` : ""} ORDER BY category, name`;
  const rows = q ? all(sql, [like, like, like, like]) : all(sql);
  return rows.map(normalizeCapability);
}

export function getCapability(slugOrId) {
  return normalizeCapability(one("SELECT * FROM capabilities WHERE slug = ? OR id = ?", [slugOrId, slugOrId]));
}

export function upsertCapability(input) {
  const existing = one("SELECT * FROM capabilities WHERE slug = ?", [input.slug]);
  const timestamp = now();
  const payload = {
    slug: input.slug,
    name: input.name,
    description: input.description || "",
    category: input.category || "General",
    keywords: json(input.keywords, []),
    input_schema: json(input.inputSchema || input.input_schema || {}, {}),
    output_schema: json(input.outputSchema || input.output_schema || {}, {}),
    required_runner_tags: json(input.requiredRunnerTags || input.required_runner_tags || [], []),
    required_skills: json(input.requiredSkills || input.required_skills || [], []),
    required_agents: json(input.requiredAgents || input.required_agents || [], []),
    approval_policy: json(input.approvalPolicy || input.approval_policy || {}, {}),
    supervision: json(input.supervision || input.supervision_policy || {}, {}),
    workflow: json(input.workflow || {}, {}),
    enabled: input.enabled === false ? 0 : 1,
    updated_at: timestamp
  };
  if (existing) {
    const version = existing.version + 1;
    run(
      `UPDATE capabilities SET name=$name, description=$description, category=$category, keywords=$keywords,
       input_schema=$input_schema, output_schema=$output_schema, required_runner_tags=$required_runner_tags,
       required_skills=$required_skills, required_agents=$required_agents, approval_policy=$approval_policy,
       supervision=$supervision, workflow=$workflow, enabled=$enabled, version=$version, updated_at=$updated_at WHERE slug=$slug`,
      { ...payload, version }
    );
    snapshotCapability(existing.id);
    return getCapability(input.slug);
  }
  const created = { id: id("cap"), version: 1, created_at: timestamp, ...payload };
  run(
    `INSERT INTO capabilities
     (id, slug, name, description, category, keywords, input_schema, output_schema, required_runner_tags,
      required_skills, required_agents, approval_policy, supervision, workflow, version, enabled, created_at, updated_at)
     VALUES ($id, $slug, $name, $description, $category, $keywords, $input_schema, $output_schema,
      $required_runner_tags, $required_skills, $required_agents, $approval_policy, $supervision, $workflow, $version,
      $enabled, $created_at, $updated_at)`,
    created
  );
  snapshotCapability(created.id);
  return getCapability(input.slug);
}

function normalizeWorkflowEndpoint(row, { includeSecretHash = false } = {}) {
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
    config: parseJson(row.config, {}),
    enabled: Boolean(row.enabled),
    secretConfigured: Boolean(row.secret_hash),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(includeSecretHash ? { secretHash: row.secret_hash } : {})
  };
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

export function listWorkflowEndpoints({ includeDisabled = false } = {}) {
  const rows = includeDisabled
    ? all("SELECT * FROM workflow_endpoints ORDER BY slug")
    : all("SELECT * FROM workflow_endpoints WHERE enabled = 1 ORDER BY slug");
  return rows.map((row) => normalizeWorkflowEndpoint(row));
}

export function getWorkflowEndpoint(slugOrId, { includeSecretHash = false, includeDisabled = false } = {}) {
  const row = includeDisabled
    ? one("SELECT * FROM workflow_endpoints WHERE slug = ? OR id = ?", [slugOrId, slugOrId])
    : one("SELECT * FROM workflow_endpoints WHERE (slug = ? OR id = ?) AND enabled = 1", [slugOrId, slugOrId]);
  return normalizeWorkflowEndpoint(row, { includeSecretHash });
}

export function upsertWorkflowEndpoint(input, options = {}) {
  const slug = input.slug;
  if (!slug) throw new Error("workflow endpoint slug is required");
  const existing = one("SELECT * FROM workflow_endpoints WHERE slug = ?", [slug]);
  if (!existing && !options.secret) throw new Error("workflow endpoint secret is required for new endpoints");
  const timestamp = now();
  const payload = {
    slug,
    name: input.name || slug,
    description: input.description || "",
    secret_hash: options.secret ? hashToken(options.secret) : existing.secret_hash,
    capability_slug: input.capabilitySlug || input.capability_slug || existing?.capability_slug || "",
    project: input.project || existing?.project || "",
    repo: input.repo || existing?.repo || "",
    repo_dir: input.repoDir || input.repo_dir || existing?.repo_dir || "",
    max_payload_bytes: positiveInteger(input.maxPayloadBytes || input.max_payload_bytes, existing?.max_payload_bytes || 32 * 1024, {
      min: 1024,
      max: 1024 * 1024
    }),
    rate_limit_count: positiveInteger(input.rateLimitCount || input.rate_limit_count, existing?.rate_limit_count || 30, {
      min: 1,
      max: 10_000
    }),
    rate_limit_window_ms: positiveInteger(input.rateLimitWindowMs || input.rate_limit_window_ms, existing?.rate_limit_window_ms || 60_000, {
      min: 1000,
      max: 86_400_000
    }),
    dedupe_window_ms: positiveInteger(input.dedupeWindowMs ?? input.dedupe_window_ms, existing?.dedupe_window_ms || 10 * 60_000, {
      min: 0,
      max: 86_400_000
    }),
    config: json(input.config || parseJson(existing?.config, {}), {}),
    enabled: input.enabled == null ? (existing?.enabled ?? 1) : input.enabled === false ? 0 : 1,
    updated_at: timestamp
  };
  if (existing) {
    run(
      `UPDATE workflow_endpoints SET name=$name, description=$description, secret_hash=$secret_hash,
       capability_slug=$capability_slug, project=$project, repo=$repo, repo_dir=$repo_dir,
       max_payload_bytes=$max_payload_bytes, rate_limit_count=$rate_limit_count,
       rate_limit_window_ms=$rate_limit_window_ms, dedupe_window_ms=$dedupe_window_ms,
       config=$config, enabled=$enabled, updated_at=$updated_at WHERE slug=$slug`,
      payload
    );
  } else {
    run(
      `INSERT INTO workflow_endpoints
       (id, slug, name, description, secret_hash, capability_slug, project, repo, repo_dir,
        max_payload_bytes, rate_limit_count, rate_limit_window_ms, dedupe_window_ms, config,
        enabled, created_at, updated_at)
       VALUES ($id, $slug, $name, $description, $secret_hash, $capability_slug, $project, $repo, $repo_dir,
        $max_payload_bytes, $rate_limit_count, $rate_limit_window_ms, $dedupe_window_ms, $config,
        $enabled, $created_at, $updated_at)`,
      { id: id("wend"), created_at: timestamp, ...payload }
    );
  }
  return getWorkflowEndpoint(slug, { includeDisabled: true });
}

export function countWorkflowEndpointInvocations(endpointId, sinceIso) {
  return one(
    "SELECT COUNT(*) AS count FROM workflow_endpoint_invocations WHERE endpoint_id = ? AND created_at >= ?",
    [endpointId, sinceIso]
  ).count;
}

export function findRecentWorkflowEndpointInvocation(endpointId, payloadHash, sinceIso) {
  const row = one(
    `SELECT * FROM workflow_endpoint_invocations
      WHERE endpoint_id = ? AND payload_hash = ? AND created_at >= ? AND run_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [endpointId, payloadHash, sinceIso]
  );
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

export function recordWorkflowEndpointInvocation({ endpoint, payloadHash, source = {}, runId = null, status = "queued" }) {
  const record = {
    id: id("weni"),
    endpoint_id: endpoint.id,
    endpoint_slug: endpoint.slug,
    payload_hash: payloadHash,
    source_app: source.app || "",
    source_user: source.user || "",
    source_session: source.session || "",
    run_id: runId,
    status,
    created_at: now()
  };
  run(
    `INSERT INTO workflow_endpoint_invocations
     (id, endpoint_id, endpoint_slug, payload_hash, source_app, source_user, source_session, run_id, status, created_at)
     VALUES ($id, $endpoint_id, $endpoint_slug, $payload_hash, $source_app, $source_user, $source_session, $run_id, $status, $created_at)`,
    record
  );
  return {
    id: record.id,
    endpointId: record.endpoint_id,
    endpointSlug: record.endpoint_slug,
    payloadHash,
    sourceApp: record.source_app,
    sourceUser: record.source_user,
    sourceSession: record.source_session,
    runId,
    status,
    createdAt: record.created_at
  };
}

// --- Per-run response endpoints --------------------------------------------
// Slice 1 of the response-egress contract (see specs/run-response-endpoints.md).
// Callers may attach an optional `responseEndpoint` to a run at creation time.
// We store it here, normalized, so delivery (slice 2) can read it back without
// having to scrape the run's `input` field — keeping the raw config out of
// workflow context, logs, and audit detail.

const VALID_RESPONSE_ENDPOINT_DELIVERY_STATUSES = new Set([
  "pending",
  "in_flight",
  "delivered",
  "failed",
  "abandoned"
]);

function normalizeRunResponseEndpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    config: parseJson(row.config, {}),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    deliveryStatus: row.delivery_status || "pending",
    deliveryAttempts: row.delivery_attempts || 0,
    lastAttemptAt: row.last_attempt_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

// Insert a new endpoint row attached to `runId`. The caller (HTTP route) is
// responsible for validating type/config first via parseResponseEndpoint;
// this function trusts both fields.
export function createRunResponseEndpoint({ runId, type, config, createdBy = "" }) {
  if (!runId) throw new Error("createRunResponseEndpoint: runId is required");
  if (!type) throw new Error("createRunResponseEndpoint: type is required");
  const timestamp = now();
  const record = {
    id: id("rres"),
    run_id: runId,
    type,
    config: json(config || {}, {}),
    created_by: createdBy || "",
    created_at: timestamp,
    delivery_status: "pending",
    delivery_attempts: 0,
    last_attempt_at: null,
    delivered_at: null,
    last_error: null,
    updated_at: timestamp
  };
  run(
    `INSERT INTO run_response_endpoints
     (id, run_id, type, config, created_by, created_at, delivery_status,
      delivery_attempts, last_attempt_at, delivered_at, last_error, updated_at)
     VALUES ($id, $run_id, $type, $config, $created_by, $created_at, $delivery_status,
      $delivery_attempts, $last_attempt_at, $delivered_at, $last_error, $updated_at)`,
    record
  );
  return normalizeRunResponseEndpoint(one("SELECT * FROM run_response_endpoints WHERE id = ?", [record.id]));
}

export function listRunResponseEndpointsForRun(runId) {
  if (!runId) return [];
  return all(
    "SELECT * FROM run_response_endpoints WHERE run_id = ? ORDER BY created_at ASC",
    [runId]
  ).map(normalizeRunResponseEndpoint);
}

// Slice 2 will use this for the delivery loop. Left here so the schema and
// helper surface are complete in slice 1.
export function listPendingRunResponseEndpoints(limit = 100) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return all(
    "SELECT * FROM run_response_endpoints WHERE delivery_status = 'pending' ORDER BY created_at ASC LIMIT ?",
    [capped]
  ).map(normalizeRunResponseEndpoint);
}

export function updateRunResponseEndpointDelivery(id, updates = {}) {
  if (!id) throw new Error("updateRunResponseEndpointDelivery: id is required");
  if (updates.status && !VALID_RESPONSE_ENDPOINT_DELIVERY_STATUSES.has(updates.status)) {
    throw new Error(`updateRunResponseEndpointDelivery: unknown status '${updates.status}'`);
  }
  const sets = ["updated_at = $updated_at"];
  const params = { id, updated_at: now() };
  if (updates.status != null) {
    sets.push("delivery_status = $delivery_status");
    params.delivery_status = updates.status;
  }
  if (updates.attempts != null) {
    sets.push("delivery_attempts = $delivery_attempts");
    params.delivery_attempts = Math.max(0, Math.floor(Number(updates.attempts) || 0));
  }
  if (updates.lastAttemptAt !== undefined) {
    sets.push("last_attempt_at = $last_attempt_at");
    params.last_attempt_at = updates.lastAttemptAt || null;
  }
  if (updates.deliveredAt !== undefined) {
    sets.push("delivered_at = $delivered_at");
    params.delivered_at = updates.deliveredAt || null;
  }
  if (updates.lastError !== undefined) {
    sets.push("last_error = $last_error");
    params.last_error = updates.lastError ? String(updates.lastError).slice(0, 2000) : null;
  }
  run(`UPDATE run_response_endpoints SET ${sets.join(", ")} WHERE id = $id`, params);
  return normalizeRunResponseEndpoint(one("SELECT * FROM run_response_endpoints WHERE id = ?", [id]));
}

function snapshotCapability(capabilityId) {
  const cap = one("SELECT * FROM capabilities WHERE id = ?", [capabilityId]);
  if (!cap) return;
  run(
    "INSERT INTO capability_versions (id, capability_id, version, snapshot, created_at) VALUES (?, ?, ?, ?, ?)",
    [id("capv"), capabilityId, cap.version, JSON.stringify(normalizeCapability(cap)), now()]
  );
}

function normalizeEditable(row, fields) {
  if (!row) return null;
  const base = {};
  for (const field of fields) base[field] = row[field];
  return {
    ...base,
    tools: parseJson(row.tools, undefined),
    skillSlugs: parseJson(row.skill_slugs, undefined),
    tags: parseJson(row.tags, []),
    enabled: row.enabled == null ? undefined : Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version
  };
}

export function listAgents(q = "") {
  const like = `%${q}%`;
  return (q
    ? all("SELECT * FROM agents WHERE name LIKE ? OR slug LIKE ? OR description LIKE ? ORDER BY name", [like, like, like])
    : all("SELECT * FROM agents ORDER BY name")
  ).map((row) => normalizeEditable(row, ["id", "slug", "name", "description", "instructions"]));
}

export function upsertAgent(input) {
  const existing = one("SELECT * FROM agents WHERE slug = ?", [input.slug]);
  const timestamp = now();
  const payload = {
    slug: input.slug,
    name: input.name,
    description: input.description || "",
    instructions: input.instructions || "",
    tools: json(input.tools, []),
    skill_slugs: json(input.skillSlugs || input.skill_slugs || [], []),
    tags: json(input.tags, []),
    enabled: input.enabled === false ? 0 : 1,
    updated_at: timestamp
  };
  if (existing) {
    run(
      `UPDATE agents SET name=$name, description=$description, instructions=$instructions, tools=$tools,
       skill_slugs=$skill_slugs, tags=$tags, enabled=$enabled, version=version+1, updated_at=$updated_at WHERE slug=$slug`,
      payload
    );
  } else {
    run(
      `INSERT INTO agents (id, slug, name, description, instructions, tools, skill_slugs, tags, enabled, created_at, updated_at)
       VALUES ($id, $slug, $name, $description, $instructions, $tools, $skill_slugs, $tags, $enabled, $created_at, $updated_at)`,
      { id: id("agent"), created_at: timestamp, ...payload }
    );
  }
  return listAgents(input.slug)[0];
}

export function listSkills(q = "") {
  const like = `%${q}%`;
  return (q
    ? all("SELECT * FROM skills WHERE name LIKE ? OR slug LIKE ? OR description LIKE ? OR body LIKE ? ORDER BY name", [like, like, like, like])
    : all("SELECT * FROM skills ORDER BY name")
  ).map((row) => normalizeEditable(row, ["id", "slug", "name", "description", "body"]));
}

export function upsertSkill(input) {
  const existing = one("SELECT * FROM skills WHERE slug = ?", [input.slug]);
  const timestamp = now();
  const payload = {
    slug: input.slug,
    name: input.name,
    description: input.description || "",
    body: input.body || "",
    tags: json(input.tags, []),
    enabled: input.enabled === false ? 0 : 1,
    updated_at: timestamp
  };
  if (existing) {
    run(
      "UPDATE skills SET name=$name, description=$description, body=$body, tags=$tags, enabled=$enabled, version=version+1, updated_at=$updated_at WHERE slug=$slug",
      payload
    );
  } else {
    run(
      "INSERT INTO skills (id, slug, name, description, body, tags, enabled, created_at, updated_at) VALUES ($id, $slug, $name, $description, $body, $tags, $enabled, $created_at, $updated_at)",
      { id: id("skill"), created_at: timestamp, ...payload }
    );
  }
  return listSkills(input.slug)[0];
}

export function listKnowledge(q = "") {
  const like = `%${q}%`;
  return (q
    ? all("SELECT * FROM knowledge_resources WHERE title LIKE ? OR slug LIKE ? OR body LIKE ? OR tags LIKE ? ORDER BY title", [like, like, like, like])
    : all("SELECT * FROM knowledge_resources ORDER BY title")
  ).map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type,
    body: row.body,
    url: row.url,
    tags: parseJson(row.tags, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function upsertKnowledge(input) {
  const existing = one("SELECT * FROM knowledge_resources WHERE slug = ?", [input.slug]);
  const timestamp = now();
  const payload = {
    slug: input.slug,
    title: input.title,
    type: input.type || "doc",
    body: input.body || "",
    url: input.url || "",
    tags: json(input.tags, []),
    updated_at: timestamp
  };
  if (existing) {
    run("UPDATE knowledge_resources SET title=$title, type=$type, body=$body, url=$url, tags=$tags, updated_at=$updated_at WHERE slug=$slug", payload);
  } else {
    run(
      "INSERT INTO knowledge_resources (id, slug, title, type, body, url, tags, created_at, updated_at) VALUES ($id, $slug, $title, $type, $body, $url, $tags, $created_at, $updated_at)",
      { id: id("know"), created_at: timestamp, ...payload }
    );
  }
  return listKnowledge(input.slug)[0];
}

export function approvalPolicyNotifiesTelegram(policy = {}) {
  if (!policy || typeof policy !== "object") return false;
  if (policy.notifyTelegram === true || policy.telegramNotify === true) return true;
  if (policy.notifications?.telegram === true || policy.notify?.telegram === true) return true;

  const channel = String(policy.notificationChannel || policy.notifyChannel || "").toLowerCase();
  if (channel === "telegram") return true;

  const channels = policy.notificationChannels || policy.notifyChannels || [];
  return Array.isArray(channels) && channels.some((item) => String(item).toLowerCase() === "telegram");
}

function approvalPolicyRequiresRunStartApproval(policy = {}) {
  if (!policy || typeof policy !== "object") return false;
  return policy.runStartApproval === true || policy.requireRunStartApproval === true || policy.workflowStartApproval === true;
}

export function autoQueueLegacyRunStartApprovals() {
  const approvals = all(
    `SELECT approvals.*, runs.status AS run_status
       FROM approvals
       JOIN runs ON runs.id = approvals.run_id
      WHERE approvals.status = 'pending'
        AND runs.status = 'waiting_approval'`
  );
  let queued = 0;
  for (const approval of approvals) {
    const payload = parseJson(approval.payload, {});
    const kind = String(payload.approvalKind || payload.kind || "").toLowerCase();
    const scope = String(payload.approvalScope || payload.scope || "").toLowerCase();
    if (kind !== "run_start" && scope !== "workflow_start") continue;

    const timestamp = now();
    run(
      "UPDATE approvals SET status='approved', decision='approved', resolved_by='system:auto-queue', comment=?, resolved_at=? WHERE id=? AND status='pending'",
      ["Workflow-start approvals no longer block runs by default.", timestamp, approval.id]
    );
    run(
      "UPDATE runs SET status='queued', current_step='queued', updated_at=? WHERE id=? AND status='waiting_approval'",
      [timestamp, approval.run_id]
    );
    addRunEvent(approval.run_id, "approval.auto_queued", "Workflow start approval auto-queued", { approvalId: approval.id });
    queued += 1;
  }
  return queued;
}

export function createRun(capability, input, options = {}) {
  const timestamp = now();
  const approvalRequired = approvalPolicyRequiresRunStartApproval(capability.approvalPolicy);
  const status = approvalRequired ? "waiting_approval" : "queued";
  const runId = id("run");
  let storedInput = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  const execution = normalizeExecutionIntent(storedInput, options.execution || {});
  storedInput = storeExecutionIntent(storedInput, execution);
  if (options.origin) {
    storedInput.__origin = {
      ...(storedInput.__origin && typeof storedInput.__origin === "object" ? storedInput.__origin : {}),
      ...options.origin
    };
  }
  run(
    `INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version, runner_id, status,
      current_step, input, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      capability.id,
      capability.slug,
      capability.name,
      capability.version,
      options.runnerId || null,
      status,
      approvalRequired ? "waiting for approval" : "queued",
      json(storedInput, {}),
      timestamp,
      timestamp
    ]
  );
  addRunEvent(runId, "run.created", `Run created for ${capability.name}`, {
    capability: capability.slug,
    ...(execution.requested ? { execution } : {})
  });
  if (approvalRequired) {
    const requestedBy = options.requestedBy || "workflow";
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
      notifyTelegram: approvalPolicyNotifiesTelegram(capability.approvalPolicy),
      input: storedInput
    };
    if (options.origin) payload.origin = options.origin;
    if (execution.requested) payload.execution = execution;
    createApproval({
      runId,
      title: `Approve ${capability.name}`,
      description: capability.approvalPolicy?.reason || "This capability requires approval before execution.",
      requestedBy,
      payload
    });
  }
  return getRun(runId);
}

export function getRun(runId) {
  const row = one("SELECT * FROM runs WHERE id = ?", [runId]);
  return normalizeRun(row);
}

// Find a still-active supervising run-smithers run by its internal supervision
// token. Used to validate a child run's bypass marker — the token is minted by
// the Hub when it creates a supervising run and is redacted from every API
// response, so only a genuine supervised child (the run-smithers workflow
// echoing the token it received) can present a matching one. Returns the
// supervising run or null.
export function findActiveSupervisorByToken(token, wrappedCapability = "") {
  const clean = String(token || "").trim();
  if (!clean) return null;
  const rows = all(
    `SELECT * FROM runs
      WHERE capability_slug = 'run-smithers'
        AND status NOT IN ('succeeded', 'failed', 'cancelled')
      ORDER BY created_at DESC LIMIT 200`
  );
  for (const row of rows) {
    const input = parseJson(row.input, {});
    if (input?.__supervisionToken !== clean) continue;
    if (wrappedCapability && input?.wrappedCapability !== wrappedCapability) continue;
    return normalizeRun(row);
  }
  return null;
}

// Build the WHERE clause shared by listRuns / countRuns so search/time/cursor
// filters stay aligned. Returns SQL fragment + bound positional params. Cursor
// is the createdAt of the last row from the previous page (exclusive bound).
function buildRunFilterClause({ status = "", q = "", since = "", until = "", cursor = "" } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (since) {
    where.push("created_at >= ?");
    params.push(since);
  }
  if (until) {
    where.push("created_at <= ?");
    params.push(until);
  }
  if (cursor) {
    where.push("created_at < ?");
    params.push(cursor);
  }
  if (q) {
    // Plain substring match across the columns operators search by. We strip
    // `%`/`_` to avoid accidental wildcard injection — typing `%` should not
    // change the meaning of the search.
    where.push("(capability_name LIKE ? OR capability_slug LIKE ? OR id LIKE ? OR current_step LIKE ? OR COALESCE(error,'') LIKE ?)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { clause, params };
}

export function listRuns({ status = "", limit = 100, q = "", since = "", until = "", cursor = "" } = {}) {
  const { clause, params } = buildRunFilterClause({ status, q, since, until, cursor });
  const sql = `SELECT * FROM runs ${clause} ORDER BY created_at DESC LIMIT ?`;
  const rows = all(sql, [...params, limit]);
  return rows.map(normalizeRun);
}

export function countRuns({ status = "", q = "", since = "", until = "" } = {}) {
  const { clause, params } = buildRunFilterClause({ status, q, since, until });
  const sql = `SELECT COUNT(*) AS count FROM runs ${clause}`;
  return one(sql, params).count;
}

// Token id that owns a run, via the runner it was assigned to. Null if unassigned.
export function runOwnerTokenId(runId) {
  const r = one("SELECT runner_id FROM runs WHERE id = ?", [runId]);
  if (!r?.runner_id) return null;
  const runner = one("SELECT token_id FROM runners WHERE id = ?", [r.runner_id]);
  return runner?.token_id || null;
}

// Auto-fail runs that have been executing past the deadline (e.g. a runner died mid-run).
export function reapStuckRunIds(maxMs) {
  if (!maxMs || maxMs <= 0) return [];
  const cutoff = new Date(Date.now() - maxMs).toISOString();
  const stuck = all(
    "SELECT id FROM runs WHERE status IN ('assigned','running') AND COALESCE(started_at, assigned_at, created_at) < ?",
    [cutoff]
  );
  const reaped = [];
  for (const row of stuck) {
    const result = transitionRun(row.id, "failed", { current_step: "timed out", error: "run exceeded execution deadline", completed_at: now() });
    if (result.ok && !result.idempotent) {
      addRunEvent(row.id, "run.failed", "Run exceeded execution deadline");
      reaped.push(row.id);
    }
  }
  return reaped;
}

export function reapStuckRuns(maxMs) {
  return reapStuckRunIds(maxMs).length;
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
    input: parseJson(row.input, {}),
    output: parseJson(row.output, null),
    error: row.error,
    createdAt: row.created_at,
    assignedAt: row.assigned_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

export function updateRun(runId, updates) {
  const allowed = ["runner_id", "status", "current_step", "output", "error", "assigned_at", "started_at", "completed_at"];
  const sets = [];
  const params = { id: runId, updated_at: now() };
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key}=$${key}`);
    params[key] = typeof value === "object" && value !== null ? json(value) : value;
  }
  if (!sets.length) return getRun(runId);
  run(`UPDATE runs SET ${sets.join(", ")}, updated_at=$updated_at WHERE id=$id`, params);
  return getRun(runId);
}

export const RUN_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

const RUN_TRANSITIONS = {
  waiting_approval: ["queued", "cancelled"],
  queued: ["assigned", "running", "cancelled", "failed"],
  assigned: ["running", "succeeded", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: []
};

export function canTransitionRun(from, to) {
  if (from === to) return true;
  return (RUN_TRANSITIONS[from] || []).includes(to);
}

// Guarded status change. Returns {ok, run, error, code, idempotent, raced}. Re-applying a terminal status is a no-op.
export function transitionRun(runId, toStatus, updates = {}) {
  const current = getRun(runId);
  if (!current) return { ok: false, code: 404, error: "run not found" };
  if (current.status === toStatus && RUN_TERMINAL.has(toStatus)) {
    return { ok: true, idempotent: true, run: current };
  }
  // Terminal-vs-terminal race: a run already reached a terminal state (most
  // commonly an operator/deadline `cancelled`) and a slower writer — usually a
  // supervised child runner that finished just after cancellation — now reports
  // a *different* terminal status. The first terminal state is authoritative
  // (operator intent wins), so treat the late writer as a benign no-op instead
  // of a scary 409. This keeps `cannot transition cancelled to failed/succeeded`
  // noise out of the runner logs without masking real success/failure.
  if (RUN_TERMINAL.has(current.status) && RUN_TERMINAL.has(toStatus)) {
    return { ok: true, idempotent: true, raced: true, run: current };
  }
  if (!canTransitionRun(current.status, toStatus)) {
    return { ok: false, code: 409, error: `cannot transition run from '${current.status}' to '${toStatus}'`, run: current };
  }
  const updated = updateRun(runId, { status: toStatus, ...updates });
  // Release the runner slot exactly once per run when it leaves the active
  // set. We use the pre-transition state to know whether the slot was
  // actually reserved (waiting_approval / queued never reserve, but an
  // assigned/running run did).
  if (
    RUN_TERMINAL.has(toStatus)
    && current.runnerId
    && (current.status === "assigned" || current.status === "running")
  ) {
    adjustRunnerActiveRuns(current.runnerId, -1);
  }
  return { ok: true, run: updated };
}

export function addRunEvent(runId, type, message = "", data = {}) {
  const event = { id: id("evt"), run_id: runId, type, message, data: json(data, {}), created_at: now() };
  run(
    "INSERT INTO run_events (id, run_id, type, message, data, created_at) VALUES ($id, $run_id, $type, $message, $data, $created_at)",
    event
  );
  return { id: event.id, runId, type, message, data, createdAt: event.created_at };
}

export function listRunEvents(runId) {
  return all("SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC", [runId]).map((row) => ({
    id: row.id,
    runId: row.run_id,
    type: row.type,
    message: row.message,
    data: parseJson(row.data, {}),
    createdAt: row.created_at
  }));
}

// Capacity clamp keeps a misconfigured runner from advertising thousands of
// slots and starving the queue logic. The cap is intentionally generous; a
// single VPS host is expected to be in the 1–8 range.
const MAX_RUNNER_CAPACITY = 32;

function normalizeCapacity(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), MAX_RUNNER_CAPACITY);
}

export function registerRunner(input, tokenId = null) {
  // Only allow updating an existing runner record if the caller's token owns it; otherwise mint a fresh id.
  // This prevents one runner token from hijacking another runner's record by guessing its id.
  const candidate = input.id ? one("SELECT * FROM runners WHERE id = ?", [input.id]) : null;
  const existing = candidate && candidate.token_id && candidate.token_id === tokenId ? candidate : null;
  const timestamp = now();
  // A runner that doesn't advertise capacity stays at 1 — preserves the
  // pre-pool behavior where a single host ran a single concurrent job.
  const capacity = normalizeCapacity(input.capacity, existing?.capacity || 1);
  const payload = {
    id: existing ? existing.id : id("runner"),
    name: input.name || input.hostname || "runner",
    hostname: input.hostname || "",
    platform: input.platform || "",
    version: input.version || "",
    tags: json(input.tags, []),
    status: "online",
    token_id: tokenId,
    capacity,
    created_at: timestamp,
    last_heartbeat_at: timestamp
  };
  if (existing) {
    run(
      `UPDATE runners SET name=$name, hostname=$hostname, platform=$platform, version=$version,
       tags=$tags, status='online', capacity=$capacity, last_heartbeat_at=$last_heartbeat_at WHERE id=$id`,
      payload
    );
  } else {
    run(
      `INSERT INTO runners (id, name, hostname, platform, version, tags, status, token_id, capacity, active_runs, created_at, last_heartbeat_at)
       VALUES ($id, $name, $hostname, $platform, $version, $tags, $status, $token_id, $capacity, 0, $created_at, $last_heartbeat_at)`,
      payload
    );
  }
  return getRunner(payload.id);
}

export function runnerIsLive(lastHeartbeatAt) {
  if (!lastHeartbeatAt) return false;
  const last = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(last)) return false;
  return Date.now() - last <= env.runnerOfflineMs;
}

export function getRunner(runnerId) {
  const row = one("SELECT * FROM runners WHERE id = ?", [runnerId]);
  if (!row) return null;
  // Heartbeat-derived liveness: a runner that stopped reporting is offline regardless of its stored status.
  const live = runnerIsLive(row.last_heartbeat_at);
  const capacity = normalizeCapacity(row.capacity, 1);
  // active_runs is clamped to [0, capacity] for display so a stale counter
  // (e.g. a runner that crashed without releasing a slot) never reads as
  // "negative free slots" in the UI.
  const activeRuns = Math.min(Math.max(Number(row.active_runs) || 0, 0), capacity);
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    version: row.version,
    tags: parseJson(row.tags, []),
    status: live ? row.status === "offline" ? "online" : row.status : "offline",
    online: live,
    currentRunId: row.current_run_id,
    capacity,
    activeRuns,
    availableSlots: Math.max(0, capacity - activeRuns),
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at
  };
}

export function listRunners() {
  return all("SELECT * FROM runners ORDER BY last_heartbeat_at DESC").map((row) => getRunner(row.id));
}

export function heartbeatRunner(runnerId, input = {}) {
  const timestamp = now();
  // Capacity / activeRuns ride along on each heartbeat so the Hub UI sees a
  // running pool size update even when the runner restarts with a different
  // SMITHERS_RUNNER_CONCURRENCY. Both are optional — a legacy runner that
  // doesn't send them keeps its stored values, which preserves the
  // single-slot behavior for unchanged deployments.
  const capacityProvided = input.capacity != null;
  const activeProvided = input.activeRuns != null;
  const capacity = capacityProvided ? normalizeCapacity(input.capacity, 1) : null;
  const active = activeProvided ? Math.max(0, Math.floor(Number(input.activeRuns) || 0)) : null;
  run(
    `UPDATE runners SET status='online',
       last_heartbeat_at=?,
       tags=COALESCE(?, tags),
       current_run_id=?,
       capacity=COALESCE(?, capacity),
       active_runs=COALESCE(?, active_runs)
     WHERE id=?`,
    [
      timestamp,
      input.tags ? json(input.tags, []) : null,
      input.currentRunId || null,
      capacity,
      active,
      runnerId
    ]
  );
  return getRunner(runnerId);
}

// Internal helper — adjust a runner's active-run counter atomically. Used by
// claimNextRun (when a slot is taken) and by terminal run transitions (when a
// slot is released). Clamped to >= 0 so a double-release never produces a
// negative counter.
function adjustRunnerActiveRuns(runnerId, delta) {
  if (!runnerId) return;
  run(
    `UPDATE runners SET active_runs = MAX(0, COALESCE(active_runs, 0) + ?) WHERE id = ?`,
    [delta, runnerId]
  );
}

function runnerMatches(capability, runner, run) {
  if (!runner) return false;
  const tags = new Set(runner.tags || []);
  if (!(capability.requiredRunnerTags || []).every((tag) => tags.has(tag))) return false;
  return executionIntentMatchesRunnerTags(executionIntentFromInput(run?.input || {}), runner.tags || []);
}

export function claimNextRun(runnerId) {
  const runner = getRunner(runnerId);
  if (!runner || !runner.online) return null;
  // Capacity gate: a runner that already has `capacity` jobs in flight gets
  // no new work until one of them releases a slot. This keeps the centralized
  // Hub queue and lets a 4-slot VPS runner sit alongside a 1-slot laptop
  // runner without the bigger pool starving the smaller one mid-cycle.
  if (runner.availableSlots <= 0) return null;
  const queued = listRuns({ status: "queued", limit: 200 });
  for (const candidate of queued) {
    // Targeting: a run pre-assigned to a specific runner (e.g. "run on my laptop" vs "run on the VPS")
    // is only claimable by that runner. Untargeted runs are claimable by any matching runner.
    if (candidate.runnerId && candidate.runnerId !== runnerId) continue;
    const capability = getCapability(candidate.capabilitySlug);
    if (!runnerMatches(capability, runner, candidate)) continue;
    // Atomic claim: only succeeds if still queued and not targeted away, so two runners never both win it.
    const timestamp = now();
    const result = run(
      "UPDATE runs SET runner_id=?, status='assigned', current_step='assigned to runner', assigned_at=?, updated_at=? WHERE id=? AND status='queued' AND (runner_id IS NULL OR runner_id=?)",
      [runnerId, timestamp, timestamp, candidate.id, runnerId]
    );
    if (!result.changes) continue;
    // Reserve the runner slot before anyone reads its capacity again.
    adjustRunnerActiveRuns(runnerId, 1);
    addRunEvent(candidate.id, "run.assigned", `Assigned to ${runner.name}`, { runnerId });
    return { run: getRun(candidate.id), capability };
  }
  return null;
}

// Counts queued / assigned / running runs — exposed so the Hub UI can render
// a "queue depth" stat without scanning the whole run list.
export function runnerPoolStats() {
  const queued = one("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'").count;
  const assigned = one("SELECT COUNT(*) AS count FROM runs WHERE status = 'assigned'").count;
  const running = one("SELECT COUNT(*) AS count FROM runs WHERE status = 'running'").count;
  const waitingApproval = one("SELECT COUNT(*) AS count FROM runs WHERE status = 'waiting_approval'").count;
  const runners = listRunners();
  const live = runners.filter((r) => r.online);
  const totalCapacity = live.reduce((sum, r) => sum + (r.capacity || 0), 0);
  const totalActive = live.reduce((sum, r) => sum + (r.activeRuns || 0), 0);
  return {
    queued,
    assigned,
    running,
    waitingApproval,
    totalCapacity,
    totalActive,
    availableSlots: Math.max(0, totalCapacity - totalActive),
    onlineRunners: live.length,
    runners: runners.length
  };
}

export function createArtifact({ runId, name, kind = "file", mimeType = "application/octet-stream", sizeBytes = 0, path: filePath, metadata = {} }) {
  const record = {
    id: id("art"),
    run_id: runId,
    name,
    kind,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    path: filePath,
    metadata: json(metadata, {}),
    created_at: now()
  };
  run(
    `INSERT INTO artifacts (id, run_id, name, kind, mime_type, size_bytes, path, metadata, created_at)
     VALUES ($id, $run_id, $name, $kind, $mime_type, $size_bytes, $path, $metadata, $created_at)`,
    record
  );
  addRunEvent(runId, "artifact.created", `Artifact stored: ${name}`, { artifactId: record.id });
  return getArtifact(record.id);
}

export function getArtifact(artifactId) {
  const row = one("SELECT * FROM artifacts WHERE id = ?", [artifactId]);
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    path: row.path,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at
  };
}

export function listArtifacts({ runId = "", q = "" } = {}) {
  if (runId) return all("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC", [runId]).map((row) => getArtifact(row.id));
  if (q) {
    const like = `%${q}%`;
    return all("SELECT * FROM artifacts WHERE name LIKE ? OR metadata LIKE ? ORDER BY created_at DESC LIMIT 100", [like, like]).map((row) => getArtifact(row.id));
  }
  return all("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 100").map((row) => getArtifact(row.id));
}

export function createApproval({ runId = null, title, description = "", requestedBy = "workflow", payload = {} }) {
  const approval = {
    id: id("appr"),
    run_id: runId,
    status: "pending",
    title,
    description,
    requested_by: requestedBy,
    payload: json(payload, {}),
    created_at: now()
  };
  run(
    `INSERT INTO approvals (id, run_id, status, title, description, requested_by, payload, created_at)
     VALUES ($id, $run_id, $status, $title, $description, $requested_by, $payload, $created_at)`,
    approval
  );
  if (runId) addRunEvent(runId, "approval.requested", title, { approvalId: approval.id });
  return getApproval(approval.id);
}

export function getApproval(approvalId) {
  const row = one("SELECT * FROM approvals WHERE id = ?", [approvalId]);
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    title: row.title,
    description: row.description,
    requestedBy: row.requested_by,
    payload: parseJson(row.payload, {}),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    decision: row.decision,
    comment: row.comment
  };
}

export function listApprovals(status = "") {
  const rows = status
    ? all("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC", [status])
    : all("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100");
  return rows.map((row) => getApproval(row.id));
}

export function resolveApproval(approvalId, decision, resolvedBy = "api", comment = "") {
  const normalizedDecision = decision === "approved" ? "approved" : decision === "changes_requested" ? "changes_requested" : "rejected";
  const resolution = {
    approved: {
      status: "approved",
      auditAction: "approval.approved",
      eventType: "approval.approved",
      runStatus: "queued",
      currentStep: "approval granted; queued",
      completedAt: null
    },
    rejected: {
      status: "rejected",
      auditAction: "approval.rejected",
      eventType: "approval.rejected",
      runStatus: "cancelled",
      currentStep: "approval rejected",
      completedAt: now()
    },
    changes_requested: {
      status: "rejected",
      auditAction: "approval.changes_requested",
      eventType: "approval.changes_requested",
      runStatus: "cancelled",
      currentStep: "changes requested; run cancelled",
      completedAt: now()
    }
  }[normalizedDecision];
  run(
    "UPDATE approvals SET status=?, decision=?, resolved_by=?, comment=?, resolved_at=? WHERE id=? AND status='pending'",
    [resolution.status, normalizedDecision, resolvedBy, comment, now(), approvalId]
  );
  const approval = getApproval(approvalId);
  if (approval) recordAudit(resolvedBy, resolution.auditAction, approvalId, { runId: approval.runId, decision: normalizedDecision, comment });
  if (approval?.runId) {
    addRunEvent(approval.runId, resolution.eventType, approval.title, { approvalId, decision: normalizedDecision, comment });
    const runRecord = getRun(approval.runId);
    if (runRecord?.status === "waiting_approval") {
      updateRun(approval.runId, {
        status: resolution.runStatus,
        current_step: resolution.currentStep,
        completed_at: resolution.completedAt
      });
    }
  }
  return approval;
}

export function recordAudit(actor, action, target = null, detail = {}) {
  const entry = { id: id("aud"), actor: actor || "", action, target, detail: json(detail, {}), created_at: now() };
  run(
    "INSERT INTO audit_log (id, actor, action, target, detail, created_at) VALUES ($id, $actor, $action, $target, $detail, $created_at)",
    entry
  );
  return { id: entry.id, actor: entry.actor, action, target, detail, createdAt: entry.created_at };
}

export function listAudit({ limit = 100 } = {}) {
  return all("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?", [limit]).map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    detail: parseJson(row.detail, {}),
    createdAt: row.created_at
  }));
}

export function dashboardStats() {
  const counts = {};
  for (const table of ["capabilities", "agents", "skills", "knowledge_resources", "runners", "runs", "artifacts", "approvals"]) {
    counts[table] = one(`SELECT COUNT(*) AS count FROM ${table}`).count;
  }
  counts.pendingApprovals = one("SELECT COUNT(*) AS count FROM approvals WHERE status='pending'").count;
  counts.runningRuns = one("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'assigned', 'running', 'waiting_approval')").count;
  // Pool / queue breakdown so the UI can render runner capacity and a
  // queue-depth chip without having to fan-out to /api/runners + /api/runs.
  const pool = runnerPoolStats();
  counts.queuedRuns = pool.queued;
  counts.assignedRuns = pool.assigned;
  counts.activeRuns = pool.running;
  counts.waitingApprovalRuns = pool.waitingApproval;
  counts.onlineRunners = pool.onlineRunners;
  counts.runnerCapacity = pool.totalCapacity;
  counts.runnerActiveSlots = pool.totalActive;
  counts.runnerAvailableSlots = pool.availableSlots;
  return counts;
}

initDb();
