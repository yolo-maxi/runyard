import { existsSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env.js";
import { id, now } from "./ids.js";
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

    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
  `);

  setSettingDefault("instance_name", env.instanceName);
  seedAll();
  ensureBootstrapToken();
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

export function createAccessToken(name, token = randomToken(), scopes = ["api"]) {
  const record = {
    id: id("tok"),
    name,
    token_hash: hashToken(token),
    scopes: json(scopes, []),
    created_at: now()
  };
  run(
    "INSERT INTO access_tokens (id, name, token_hash, scopes, created_at) VALUES ($id, $name, $token_hash, $scopes, $created_at)",
    record
  );
  return { id: record.id, name, token, scopes, createdAt: record.created_at };
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
    workflow: parseJson(row.workflow, {}),
    version: row.version,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listCapabilities({ q = "" } = {}) {
  const like = `%${q}%`;
  const rows = q
    ? all(
        `SELECT * FROM capabilities
         WHERE name LIKE ? OR slug LIKE ? OR description LIKE ? OR keywords LIKE ?
         ORDER BY category, name`,
        [like, like, like, like]
      )
    : all("SELECT * FROM capabilities ORDER BY category, name");
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
       workflow=$workflow, enabled=$enabled, version=$version, updated_at=$updated_at WHERE slug=$slug`,
      { ...payload, version }
    );
    snapshotCapability(existing.id);
    return getCapability(input.slug);
  }
  const created = { id: id("cap"), version: 1, created_at: timestamp, ...payload };
  run(
    `INSERT INTO capabilities
     (id, slug, name, description, category, keywords, input_schema, output_schema, required_runner_tags,
      required_skills, required_agents, approval_policy, workflow, version, enabled, created_at, updated_at)
     VALUES ($id, $slug, $name, $description, $category, $keywords, $input_schema, $output_schema,
      $required_runner_tags, $required_skills, $required_agents, $approval_policy, $workflow, $version,
      $enabled, $created_at, $updated_at)`,
    created
  );
  snapshotCapability(created.id);
  return getCapability(input.slug);
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

export function createRun(capability, input, options = {}) {
  const timestamp = now();
  const approvalRequired = Boolean(capability.approvalPolicy?.required);
  const status = approvalRequired ? "waiting_approval" : "queued";
  const runId = id("run");
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
      json(input, {}),
      timestamp,
      timestamp
    ]
  );
  addRunEvent(runId, "run.created", `Run created for ${capability.name}`, { capability: capability.slug });
  if (approvalRequired) {
    createApproval({
      runId,
      title: `Approve ${capability.name}`,
      description: capability.approvalPolicy?.reason || "This capability requires approval before execution.",
      payload: { capability: capability.slug, input }
    });
  }
  return getRun(runId);
}

export function getRun(runId) {
  const row = one("SELECT * FROM runs WHERE id = ?", [runId]);
  return normalizeRun(row);
}

export function listRuns({ status = "", limit = 100 } = {}) {
  const rows = status
    ? all("SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC LIMIT ?", [status, limit])
    : all("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", [limit]);
  return rows.map(normalizeRun);
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

export function registerRunner(input, tokenId = null) {
  const existing = input.id ? one("SELECT * FROM runners WHERE id = ?", [input.id]) : null;
  const timestamp = now();
  const payload = {
    id: input.id || id("runner"),
    name: input.name || input.hostname || "runner",
    hostname: input.hostname || "",
    platform: input.platform || "",
    version: input.version || "",
    tags: json(input.tags, []),
    status: "online",
    token_id: tokenId,
    created_at: timestamp,
    last_heartbeat_at: timestamp
  };
  if (existing) {
    run(
      `UPDATE runners SET name=$name, hostname=$hostname, platform=$platform, version=$version,
       tags=$tags, status='online', last_heartbeat_at=$last_heartbeat_at WHERE id=$id`,
      payload
    );
  } else {
    run(
      `INSERT INTO runners (id, name, hostname, platform, version, tags, status, token_id, created_at, last_heartbeat_at)
       VALUES ($id, $name, $hostname, $platform, $version, $tags, $status, $token_id, $created_at, $last_heartbeat_at)`,
      payload
    );
  }
  return getRunner(payload.id);
}

export function getRunner(runnerId) {
  const row = one("SELECT * FROM runners WHERE id = ?", [runnerId]);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    version: row.version,
    tags: parseJson(row.tags, []),
    status: row.status,
    currentRunId: row.current_run_id,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at
  };
}

export function listRunners() {
  return all("SELECT * FROM runners ORDER BY last_heartbeat_at DESC").map((row) => getRunner(row.id));
}

export function heartbeatRunner(runnerId, input = {}) {
  const timestamp = now();
  run("UPDATE runners SET status='online', last_heartbeat_at=?, tags=COALESCE(?, tags), current_run_id=? WHERE id=?", [
    timestamp,
    input.tags ? json(input.tags, []) : null,
    input.currentRunId || null,
    runnerId
  ]);
  return getRunner(runnerId);
}

function runnerMatches(capability, runner) {
  if (!runner) return false;
  const tags = new Set(runner.tags || []);
  return (capability.requiredRunnerTags || []).every((tag) => tags.has(tag));
}

export function claimNextRun(runnerId) {
  const runner = getRunner(runnerId);
  if (!runner) return null;
  const queued = listRuns({ status: "queued", limit: 200 });
  for (const candidate of queued) {
    const capability = getCapability(candidate.capabilitySlug);
    if (!runnerMatches(capability, runner)) continue;
    const claimed = updateRun(candidate.id, {
      runner_id: runnerId,
      status: "assigned",
      current_step: "assigned to runner",
      assigned_at: now()
    });
    addRunEvent(candidate.id, "run.assigned", `Assigned to ${runner.name}`, { runnerId });
    return { run: claimed, capability };
  }
  return null;
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
  const status = decision === "approved" ? "approved" : "rejected";
  run(
    "UPDATE approvals SET status=?, decision=?, resolved_by=?, comment=?, resolved_at=? WHERE id=? AND status='pending'",
    [status, decision, resolvedBy, comment, now(), approvalId]
  );
  const approval = getApproval(approvalId);
  if (approval?.runId) {
    addRunEvent(approval.runId, `approval.${status}`, approval.title, { approvalId, comment });
    const runRecord = getRun(approval.runId);
    if (runRecord?.status === "waiting_approval") {
      updateRun(approval.runId, {
        status: status === "approved" ? "queued" : "cancelled",
        current_step: status === "approved" ? "approval granted; queued" : "approval rejected",
        completed_at: status === "rejected" ? now() : null
      });
    }
  }
  return approval;
}

export function dashboardStats() {
  const counts = {};
  for (const table of ["capabilities", "agents", "skills", "knowledge_resources", "runners", "runs", "artifacts", "approvals"]) {
    counts[table] = one(`SELECT COUNT(*) AS count FROM ${table}`).count;
  }
  counts.pendingApprovals = one("SELECT COUNT(*) AS count FROM approvals WHERE status='pending'").count;
  counts.runningRuns = one("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'assigned', 'running', 'waiting_approval')").count;
  return counts;
}

initDb();
