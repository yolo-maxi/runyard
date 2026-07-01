import { parseMaybeJson } from "./dbNormalization.js";
import { clampActiveRuns, normalizeRunnerCapacity, runnerHealthSummary } from "./runnerPoolPolicy.js";
export {
  runnerPoolStatusQueries,
  runnerPoolSummary,
  runStatusCountQuery
} from "./runnerPoolRecords.js";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function runnerRegistrationPayload({ input = {}, existing = null, id, tokenId = null, timestamp }) {
  const capacity = normalizeRunnerCapacity(input.capacity, existing?.capacity || 1);
  return {
    id: existing ? existing.id : id,
    name: input.name || input.hostname || "runner",
    hostname: input.hostname || "",
    platform: input.platform || "",
    version: input.version || "",
    tags: jsonField(input.tags, []),
    status: "online",
    token_id: tokenId,
    capacity,
    created_at: timestamp,
    last_heartbeat_at: timestamp
  };
}

export function runnerOwnedLookupQuery(runnerId) {
  return {
    sql: "SELECT * FROM runners WHERE id = ?",
    params: [runnerId]
  };
}

export function runnerStableIdentityLookupQuery({ tokenId, name, hostname }) {
  return {
    sql: "SELECT * FROM runners WHERE token_id = ? AND name = ? AND hostname = ? ORDER BY last_heartbeat_at DESC LIMIT 1",
    params: [tokenId, name, hostname]
  };
}

export function runnerRegistrationUpdateQuery(payload) {
  return {
    sql: `UPDATE runners SET name=$name, hostname=$hostname, platform=$platform, version=$version,
       tags=$tags, status='online', capacity=$capacity, last_heartbeat_at=$last_heartbeat_at WHERE id=$id`,
    params: {
      id: payload.id,
      name: payload.name,
      hostname: payload.hostname,
      platform: payload.platform,
      version: payload.version,
      tags: payload.tags,
      capacity: payload.capacity,
      last_heartbeat_at: payload.last_heartbeat_at
    }
  };
}

export function runnerRegistrationInsertQuery() {
  return {
    sql: `INSERT INTO runners (id, name, hostname, platform, version, tags, status, token_id, capacity, active_runs, created_at, last_heartbeat_at)
       VALUES ($id, $name, $hostname, $platform, $version, $tags, $status, $token_id, $capacity, 0, $created_at, $last_heartbeat_at)`
  };
}

// Whitelist the auth-health shape the Hub will persist. Defense in depth: even
// if a runner (or a compromised runner token) posts token material under
// `auth`, only these scalar fields survive — never an access/refresh token.
export function sanitizeRunnerAuthHealth(auth) {
  if (!auth || typeof auth !== "object") return {};
  const pickProvider = (provider) => {
    if (!provider || typeof provider !== "object") return undefined;
    const out = { ok: Boolean(provider.ok) };
    if (provider.expiresAt != null) out.expiresAt = String(provider.expiresAt).slice(0, 64);
    if (provider.accountId != null) out.accountId = String(provider.accountId).slice(0, 128);
    if (provider.error != null) out.error = String(provider.error).slice(0, 200);
    return out;
  };
  const result = {};
  const codex = pickProvider(auth.codex);
  const claude = pickProvider(auth.claude);
  const hub = pickProvider(auth.hub);
  if (codex) result.codex = codex;
  if (claude) result.claude = claude;
  // Hub claim-auth status: surfaces "registered/online but every claim is
  // rejected" (dead token / wrong hub URL) so it can't masquerade as healthy.
  if (hub) result.hub = hub;
  if (auth.checkedAt != null) result.checkedAt = String(auth.checkedAt).slice(0, 64);
  return result;
}

export function runnerHeartbeatParams({ input = {}, timestamp, runnerId }) {
  const capacityProvided = input.capacity != null;
  const activeProvided = input.activeRuns != null;
  return [
    timestamp,
    input.tags ? jsonField(input.tags, []) : null,
    input.currentRunId || null,
    capacityProvided ? normalizeRunnerCapacity(input.capacity, 1) : null,
    activeProvided ? Math.max(0, Math.floor(Number(input.activeRuns) || 0)) : null,
    input.auth != null ? jsonField(sanitizeRunnerAuthHealth(input.auth), {}) : null,
    runnerId
  ];
}

export function runnerListQuery() {
  return {
    sql: "SELECT * FROM runners ORDER BY last_heartbeat_at DESC",
    params: []
  };
}

export function runnerHeartbeatUpdateQuery(params) {
  return {
    sql: `UPDATE runners SET status='online',
       last_heartbeat_at=?,
       tags=COALESCE(?, tags),
       current_run_id=?,
       capacity=COALESCE(?, capacity),
       active_runs=COALESCE(?, active_runs),
       auth_health=COALESCE(?, auth_health)
     WHERE id=?`,
    params
  };
}

export function staleRunnerListQuery(seconds) {
  return {
    sql: `SELECT id FROM runners
      WHERE last_heartbeat_at IS NOT NULL
        AND datetime(last_heartbeat_at) < datetime('now', ?)
        AND COALESCE(active_runs, 0) <= 0
        AND current_run_id IS NULL`,
    params: [`-${seconds} seconds`]
  };
}

export function runnerDeleteQuery(runnerId) {
  return {
    sql: "DELETE FROM runners WHERE id = ?",
    params: [runnerId]
  };
}

export function runnerActiveRunsAdjustmentQuery({ runnerId, delta }) {
  return {
    sql: "UPDATE runners SET active_runs = MAX(0, COALESCE(active_runs, 0) + ?) WHERE id = ?",
    params: [delta, runnerId]
  };
}

export function runnerLoadQuery({ runnerId, supervisorCapabilitySlug }) {
  return {
    sql: `SELECT
        COALESCE(SUM(CASE WHEN capability_slug = ? THEN 1 ELSE 0 END), 0) AS supervisors,
        COALESCE(SUM(CASE WHEN capability_slug = ? THEN 0 ELSE 1 END), 0) AS work
       FROM runs
      WHERE runner_id = ? AND status IN ('assigned','running')`,
    params: [supervisorCapabilitySlug, supervisorCapabilitySlug, runnerId]
  };
}

export function runnerActiveRunsReconcileQuery() {
  return {
    sql: `SELECT runners.id AS id,
            COALESCE(runners.active_runs, 0) AS stored,
            (SELECT COUNT(*) FROM runs
              WHERE runs.runner_id = runners.id
                AND runs.status IN ('assigned','running')) AS actual
       FROM runners`,
    params: []
  };
}

export function runnerActiveRunsSetQuery({ runnerId, activeRuns }) {
  return {
    sql: "UPDATE runners SET active_runs = ? WHERE id = ?",
    params: [activeRuns, runnerId]
  };
}

export function normalizeRunner(row, { live, load }) {
  if (!row) return null;
  const capacity = normalizeRunnerCapacity(row.capacity, 1);
  const activeRuns = clampActiveRuns(row.active_runs, capacity);
  const authHealth = parseMaybeJson(row.auth_health, null);
  const health = runnerHealthSummary({ live, capacity, load, authHealth });
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    version: row.version,
    tags: parseMaybeJson(row.tags, []),
    status: live ? row.status === "offline" ? "online" : row.status : "offline",
    online: live,
    currentRunId: row.current_run_id,
    capacity,
    activeRuns,
    workRuns: load.work,
    supervisorRuns: load.supervisors,
    availableSlots: Math.max(0, capacity - load.work),
    health,
    // Per-runner CLI auth health (Codex/Claude). Booleans + expiry + account id
    // only — never token material. Null until the runner reports it.
    authHealth,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at
  };
}

export function runnerIsLive(lastHeartbeatAt, offlineMs) {
  if (!lastHeartbeatAt) return false;
  const last = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(last)) return false;
  return Date.now() - last <= offlineMs;
}
