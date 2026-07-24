import { parseMaybeJson } from "./dbNormalization.js";

// SCM connection records for the CI platform: GitHub App installations,
// CI-connected repositories, and the webhook delivery ledger. Provider-neutral
// shapes (provider + string ids) so a second forge can slot in later without a
// schema change. Tokens are NEVER stored in any of these rows — installation
// access tokens are minted just in time (src/githubApp.js) and live only in
// memory / the runner claim payload.

export const SCM_PROVIDERS = ["github"];

export const SCM_INSTALLATION_STATUSES = ["active", "suspended", "removed"];

// Delivery ledger statuses: what happened to one provider delivery id.
// processing -> reserved before routing (dedupe TOCTOU guard); deleted on
//               handler error so redelivery reprocesses
// accepted   -> a pipeline (or sync action) was created from it
// ignored    -> valid signature, but an event/action we don't act on
// duplicate  -> same delivery id + same payload hash seen again (replay-safe ack)
// conflict   -> same delivery id but DIFFERENT payload bytes (rejected)
// invalid    -> signature ok, payload failed validation (e.g. unknown repo)
// error      -> handler failed; safe to redeliver
export const SCM_DELIVERY_STATUSES = ["processing", "accepted", "ignored", "duplicate", "conflict", "invalid", "error"];

export const CI_TRUST_LEVELS = ["untrusted", "trusted"];

export const DEFAULT_TRUST_POLICY = Object.freeze({
  level: "untrusted",
  allowNative: false,
  runnerTags: []
});

// --- trust policy -----------------------------------------------------------

export function normalizeTrustPolicy(raw) {
  const policy = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const level = CI_TRUST_LEVELS.includes(policy.level) ? policy.level : DEFAULT_TRUST_POLICY.level;
  const runnerTags = Array.isArray(policy.runnerTags)
    ? [...new Set(policy.runnerTags.map((tag) => String(tag || "").trim()).filter(Boolean))]
    : [];
  return {
    level,
    // Native host execution is doubly gated: repo policy here AND the runner's
    // own RUNYARD_RUNNER_CI_NATIVE opt-in. An untrusted repo can never enable it.
    allowNative: level === "trusted" && Boolean(policy.allowNative),
    runnerTags
  };
}

export function validateTrustPolicyBody(body = {}) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "trustPolicy must be an object" };
  }
  if (body.level !== undefined && !CI_TRUST_LEVELS.includes(body.level)) {
    return { ok: false, error: `trustPolicy.level must be one of ${CI_TRUST_LEVELS.join(", ")}` };
  }
  if (body.allowNative !== undefined && typeof body.allowNative !== "boolean") {
    return { ok: false, error: "trustPolicy.allowNative must be a boolean" };
  }
  if (body.runnerTags !== undefined) {
    if (!Array.isArray(body.runnerTags) || body.runnerTags.some((tag) => typeof tag !== "string" || !tag.trim())) {
      return { ok: false, error: "trustPolicy.runnerTags must be an array of non-empty strings" };
    }
  }
  return { ok: true, value: normalizeTrustPolicy(body) };
}

// --- installations ----------------------------------------------------------

export function normalizeScmInstallation(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    installationId: row.installation_id,
    accountLogin: row.account_login || "",
    accountType: row.account_type || "",
    appId: row.app_id || "",
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function scmInstallationCreateRecord({ id, input, timestamp }) {
  return {
    id,
    provider: input.provider || "github",
    installation_id: String(input.installationId),
    account_login: input.accountLogin || "",
    account_type: input.accountType || "",
    app_id: String(input.appId || ""),
    status: SCM_INSTALLATION_STATUSES.includes(input.status) ? input.status : "active",
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function scmInstallationInsertQuery() {
  return {
    sql: `INSERT INTO scm_installations
     (id, provider, installation_id, account_login, account_type, app_id, status, created_at, updated_at)
     VALUES ($id, $provider, $installation_id, $account_login, $account_type, $app_id, $status, $created_at, $updated_at)`
  };
}

export function scmInstallationLookupQuery(provider, installationId) {
  return {
    sql: "SELECT * FROM scm_installations WHERE provider = ? AND installation_id = ?",
    params: [provider, String(installationId)]
  };
}

export function scmInstallationListQuery() {
  return { sql: "SELECT * FROM scm_installations ORDER BY created_at ASC", params: [] };
}

export function scmInstallationUpdateQuery({ provider, installationId, values }) {
  return {
    sql: `UPDATE scm_installations SET account_login = $account_login, account_type = $account_type,
      app_id = $app_id, status = $status, updated_at = $updated_at
      WHERE provider = $provider AND installation_id = $installation_id`,
    params: { ...values, provider, installation_id: String(installationId) }
  };
}

// --- repositories -----------------------------------------------------------

export function normalizeScmRepo(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id || "",
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    cloneUrl: row.clone_url || "",
    defaultBranch: row.default_branch || "main",
    installationId: row.installation_id || "",
    private: Boolean(row.private),
    enabled: Boolean(row.enabled),
    trustPolicy: normalizeTrustPolicy(parseMaybeJson(row.trust_policy, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function scmRepoCreateRecord({ id, input, timestamp }) {
  return {
    id,
    provider: input.provider || "github",
    external_id: String(input.externalId || ""),
    owner: input.owner,
    name: input.name,
    full_name: input.fullName,
    clone_url: input.cloneUrl || "",
    default_branch: input.defaultBranch || "main",
    installation_id: String(input.installationId || ""),
    private: input.private ? 1 : 0,
    enabled: input.enabled ? 1 : 0,
    trust_policy: JSON.stringify(normalizeTrustPolicy(input.trustPolicy)),
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function scmRepoInsertQuery() {
  return {
    sql: `INSERT INTO scm_repos
     (id, provider, external_id, owner, name, full_name, clone_url, default_branch, installation_id, private, enabled, trust_policy, created_at, updated_at)
     VALUES ($id, $provider, $external_id, $owner, $name, $full_name, $clone_url, $default_branch, $installation_id, $private, $enabled, $trust_policy, $created_at, $updated_at)`
  };
}

export function scmRepoLookupQuery(idOrFullName, { provider = "github" } = {}) {
  return {
    sql: "SELECT * FROM scm_repos WHERE id = ? OR (provider = ? AND full_name = ?)",
    params: [idOrFullName, provider, idOrFullName]
  };
}

export function scmRepoListQuery({ enabledOnly = false, installationId = "" } = {}) {
  const where = [];
  const params = [];
  if (enabledOnly) where.push("enabled = 1");
  if (installationId) {
    where.push("installation_id = ?");
    params.push(String(installationId));
  }
  return {
    sql: `SELECT * FROM scm_repos ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY full_name ASC`,
    params
  };
}

// Partial metadata update from a provider sync — identity fields only; the
// operator-owned enabled/trust_policy flags are deliberately NOT touched here.
export function scmRepoSyncValues(existing, updates, timestamp) {
  return {
    external_id: updates.externalId != null ? String(updates.externalId) : existing.external_id,
    owner: updates.owner != null ? updates.owner : existing.owner,
    name: updates.name != null ? updates.name : existing.name,
    full_name: updates.fullName != null ? updates.fullName : existing.full_name,
    clone_url: updates.cloneUrl != null ? updates.cloneUrl : existing.clone_url,
    default_branch: updates.defaultBranch != null ? updates.defaultBranch : existing.default_branch,
    installation_id: updates.installationId != null ? String(updates.installationId) : existing.installation_id,
    private: updates.private != null ? (updates.private ? 1 : 0) : existing.private,
    updated_at: timestamp
  };
}

export function scmRepoSyncQuery({ repoId, values }) {
  return {
    sql: `UPDATE scm_repos SET external_id = $external_id, owner = $owner, name = $name,
      full_name = $full_name, clone_url = $clone_url, default_branch = $default_branch,
      installation_id = $installation_id, private = $private, updated_at = $updated_at
      WHERE id = $repo_id`,
    params: { ...values, repo_id: repoId }
  };
}

export function scmRepoSetEnabledQuery({ repoId, enabled, timestamp }) {
  return {
    sql: "UPDATE scm_repos SET enabled = ?, updated_at = ? WHERE id = ?",
    params: [enabled ? 1 : 0, timestamp, repoId]
  };
}

export function scmRepoSetTrustPolicyQuery({ repoId, trustPolicy, timestamp }) {
  return {
    sql: "UPDATE scm_repos SET trust_policy = ?, updated_at = ? WHERE id = ?",
    params: [JSON.stringify(normalizeTrustPolicy(trustPolicy)), timestamp, repoId]
  };
}

// --- webhook deliveries -----------------------------------------------------

export function normalizeScmWebhookDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    deliveryId: row.delivery_id,
    event: row.event || "",
    action: row.action || "",
    payloadHash: row.payload_hash || "",
    repoFullName: row.repo_full_name || "",
    status: row.status,
    detail: parseMaybeJson(row.detail, {}),
    pipelineId: row.pipeline_id || null,
    createdAt: row.created_at
  };
}

export function scmWebhookDeliveryCreateRecord({ id, input, timestamp }) {
  return {
    id,
    provider: input.provider || "github",
    delivery_id: String(input.deliveryId),
    event: input.event || "",
    action: input.action || "",
    payload_hash: input.payloadHash || "",
    repo_full_name: input.repoFullName || "",
    status: SCM_DELIVERY_STATUSES.includes(input.status) ? input.status : "accepted",
    detail: JSON.stringify(input.detail === undefined ? {} : input.detail),
    pipeline_id: input.pipelineId || null,
    created_at: timestamp
  };
}

export function scmWebhookDeliveryInsertQuery() {
  return {
    sql: `INSERT INTO scm_webhook_deliveries
     (id, provider, delivery_id, event, action, payload_hash, repo_full_name, status, detail, pipeline_id, created_at)
     VALUES ($id, $provider, $delivery_id, $event, $action, $payload_hash, $repo_full_name, $status, $detail, $pipeline_id, $created_at)`
  };
}

export function scmWebhookDeliveryLookupQuery(provider, deliveryId) {
  return {
    sql: "SELECT * FROM scm_webhook_deliveries WHERE provider = ? AND delivery_id = ?",
    params: [provider, String(deliveryId)]
  };
}

export function scmWebhookDeliveryListQuery({ limit = 50, status = "" } = {}) {
  const where = status ? "WHERE status = ?" : "";
  const params = status ? [status, limit] : [limit];
  return {
    sql: `SELECT * FROM scm_webhook_deliveries ${where} ORDER BY created_at DESC LIMIT ?`,
    params
  };
}

export function scmWebhookDeliveryCountQuery({ status = "", sinceIso = "" } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (sinceIso) {
    where.push("created_at >= ?");
    params.push(sinceIso);
  }
  return {
    sql: `SELECT COUNT(*) AS count FROM scm_webhook_deliveries ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    params
  };
}

export function scmWebhookDeliveryUpdateQuery({ provider, deliveryId, status, action = "", repoFullName = "", detail, pipelineId }) {
  return {
    sql: `UPDATE scm_webhook_deliveries SET status = ?, action = ?, repo_full_name = ?, detail = ?, pipeline_id = ?
      WHERE provider = ? AND delivery_id = ?`,
    params: [
      SCM_DELIVERY_STATUSES.includes(status) ? status : "error",
      action || "",
      repoFullName || "",
      JSON.stringify(detail === undefined ? {} : detail),
      pipelineId || null,
      provider,
      String(deliveryId)
    ]
  };
}

// A handler error releases the reservation entirely so the provider's
// redelivery of the same id reprocesses instead of deduping.
export function scmWebhookDeliveryDeleteQuery(provider, deliveryId) {
  return {
    sql: "DELETE FROM scm_webhook_deliveries WHERE provider = ? AND delivery_id = ?",
    params: [provider, String(deliveryId)]
  };
}

// Bounded retention: the ledger only needs to cover the provider's redelivery
// window plus operator debugging. Rows older than the cutoff are deleted.
export function scmWebhookDeliveryPruneQuery(cutoffIso) {
  return {
    sql: "DELETE FROM scm_webhook_deliveries WHERE created_at < ?",
    params: [cutoffIso]
  };
}
