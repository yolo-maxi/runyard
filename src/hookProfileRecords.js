import { createHash } from "node:crypto";
import { parseMaybeJson } from "./dbNormalization.js";
import { stableJsonString } from "./stableJson.js";
import { SECRET_KEY_RE } from "./secretsRoutes.js";
import { HOOK_STATUS_CONFIG_REQUIRED } from "./hookOutcomes.js";

// Post-run hook profiles are admin-authored recipes for optional side effects
// (publish, push, notify) that run after a build/check run has produced its
// verified artifacts. Definitions are bounded on purpose: fixed kinds, fixed
// per-kind config keys, secrets referenced by NAME only, and explicit allowed
// roots — a profile can never carry raw credentials or a user-supplied shell
// fragment.
export const HOOK_KINDS = Object.freeze([
  "static-publish",
  "git-push",
  "webhook",
  "vercel-preview",
  "custom-script"
]);

// Branches a git-push hook may never target directly: merging to the default
// branch stays behind the explicit run-promotion gate (POST /runs/:id/promote).
export const PROTECTED_BRANCHES = Object.freeze(["main", "master"]);

export const HOOK_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const GIT_REMOTE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const PARAM_TYPES = ["string", "boolean", "number"];
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_LIST = 16;
const MAX_ALLOWED_CAPABILITIES = 64;

// Per-kind config contract. Every key a kind accepts is listed here; anything
// else is rejected so raw credentials or ad-hoc knobs can't be smuggled into
// config. `paths` values must be absolute.
const KIND_CONFIG_KEYS = {
  "static-publish": ["targetRoot", "urlBase", "allowedArtifactRoots"],
  "git-push": ["repoRoot", "remote", "targetBranch", "branchPrefix", "allowedRepoRoots"],
  webhook: ["url", "method", "headers", "secretHeaders"],
  "vercel-preview": ["project", "teamId"],
  "custom-script": ["command", "argv", "cwd", "timeoutSeconds", "allowedCommandPaths", "allowedArtifactRoots"]
};

function parseJsonField(value, fallback) {
  return parseMaybeJson(value, fallback);
}

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0") && value.length <= 512;
}

function cleanStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function validateParams(params, errors) {
  if (!Array.isArray(params)) {
    errors.push("params must be an array of {name, type, description, required}");
    return [];
  }
  if (params.length > MAX_LIST) errors.push(`params: at most ${MAX_LIST} entries`);
  const normalized = [];
  const seen = new Set();
  for (const entry of params.slice(0, MAX_LIST)) {
    if (!isPlainObject(entry)) {
      errors.push("params entries must be objects");
      continue;
    }
    const name = String(entry.name || "").trim();
    if (!PARAM_NAME_RE.test(name)) {
      errors.push(`params: invalid param name "${name.slice(0, 64)}"`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`params: duplicate param "${name}"`);
      continue;
    }
    seen.add(name);
    const type = String(entry.type || "string");
    if (!PARAM_TYPES.includes(type)) {
      errors.push(`params: param "${name}" has unsupported type "${type.slice(0, 20)}"`);
      continue;
    }
    normalized.push({
      name,
      type,
      description: String(entry.description || "").slice(0, 300),
      required: entry.required === true
    });
  }
  return normalized;
}

function validateSecretNames(secretNames, errors) {
  const names = cleanStringArray(secretNames);
  if (names.length > MAX_LIST) errors.push(`secretNames: at most ${MAX_LIST} entries`);
  const valid = [];
  for (const name of names.slice(0, MAX_LIST)) {
    if (!SECRET_KEY_RE.test(name)) {
      errors.push(`secretNames: "${name.slice(0, 64)}" is not an env-var-safe secret name`);
      continue;
    }
    valid.push(name);
  }
  return valid;
}

function rejectUnknownConfigKeys(kind, config, errors) {
  const allowed = KIND_CONFIG_KEYS[kind] || [];
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) {
      // Name the key but never echo its value: an operator pasting a raw
      // credential into config must not see it reflected in an error, event,
      // or audit entry.
      errors.push(`config: unknown key "${String(key).slice(0, 64)}" for kind ${kind}; secrets must be referenced via secretNames, never inlined`);
    }
  }
}

function validateAbsolutePathList(value, label, errors) {
  const list = cleanStringArray(value);
  if (list.length > MAX_LIST) errors.push(`${label}: at most ${MAX_LIST} entries`);
  const valid = [];
  for (const entry of list.slice(0, MAX_LIST)) {
    if (!isAbsolutePath(entry)) {
      errors.push(`${label}: "${entry.slice(0, 120)}" must be an absolute path`);
      continue;
    }
    valid.push(entry);
  }
  return valid;
}

function validateStaticPublishConfig(config, errors) {
  const targetRoot = String(config.targetRoot || "").trim();
  if (!isAbsolutePath(targetRoot)) errors.push("config.targetRoot is required and must be an absolute path");
  const urlBase = String(config.urlBase || "").trim();
  if (urlBase && !/^https:\/\/[^\s]{1,200}$/.test(urlBase)) errors.push("config.urlBase must be an https URL");
  return {
    targetRoot,
    ...(urlBase ? { urlBase } : {}),
    allowedArtifactRoots: validateAbsolutePathList(config.allowedArtifactRoots, "config.allowedArtifactRoots", errors)
  };
}

function validateGitPushConfig(config, errors) {
  const repoRoot = String(config.repoRoot || "").trim();
  if (!isAbsolutePath(repoRoot)) errors.push("config.repoRoot is required and must be an absolute path");
  const remote = String(config.remote || "origin").trim();
  if (!GIT_REMOTE_RE.test(remote)) {
    // Remote must be a configured remote NAME, never a URL — URLs can embed
    // credentials and bypass the repo's vetted remote configuration.
    errors.push("config.remote must be a git remote name (letters, digits, . _ -), not a URL");
  }
  const targetBranch = String(config.targetBranch || "").trim();
  const branchPrefix = String(config.branchPrefix || "").trim();
  if (targetBranch) {
    if (!BRANCH_RE.test(targetBranch)) errors.push("config.targetBranch contains unsupported characters");
    if (PROTECTED_BRANCHES.includes(targetBranch)) {
      errors.push(
        `config.targetBranch "${targetBranch}" is a protected branch; git-push hooks may only push work branches — merge to ${targetBranch} stays behind explicit run promotion (POST /api/runs/:id/promote)`
      );
    }
  }
  if (branchPrefix) {
    if (!BRANCH_RE.test(branchPrefix)) errors.push("config.branchPrefix contains unsupported characters");
    if (PROTECTED_BRANCHES.some((branch) => branchPrefix === branch || branchPrefix === `${branch}/`)) {
      errors.push(`config.branchPrefix must not target the protected branch namespace "${branchPrefix}"`);
    }
  }
  if (!targetBranch && !branchPrefix) errors.push("config: git-push requires targetBranch or branchPrefix");
  return {
    repoRoot,
    remote,
    ...(targetBranch ? { targetBranch } : {}),
    ...(branchPrefix ? { branchPrefix } : {}),
    allowedRepoRoots: validateAbsolutePathList(config.allowedRepoRoots, "config.allowedRepoRoots", errors)
  };
}

function validateWebhookConfig(config, errors) {
  const url = String(config.url || "").trim();
  let parsed = null;
  try {
    parsed = url ? new URL(url) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== "https:") errors.push("config.url is required and must be https");
  if (parsed && (parsed.username || parsed.password)) errors.push("config.url must not embed credentials");
  if (url.length > 2048) errors.push("config.url too long");
  const method = String(config.method || "POST").toUpperCase();
  if (!["POST", "PUT"].includes(method)) errors.push("config.method must be POST or PUT");
  const headers = {};
  if (config.headers !== undefined) {
    if (!isPlainObject(config.headers)) errors.push("config.headers must be an object");
    else {
      const entries = Object.entries(config.headers);
      if (entries.length > MAX_LIST) errors.push(`config.headers: at most ${MAX_LIST} entries`);
      for (const [key, value] of entries.slice(0, MAX_LIST)) {
        if (typeof value !== "string" || value.length > 512) {
          errors.push(`config.headers: value for "${String(key).slice(0, 64)}" must be a short string`);
          continue;
        }
        headers[String(key).slice(0, 128)] = value;
      }
    }
  }
  const secretHeaders = {};
  if (config.secretHeaders !== undefined) {
    if (!isPlainObject(config.secretHeaders)) errors.push("config.secretHeaders must be an object of {header: secretName}");
    else {
      for (const [key, value] of Object.entries(config.secretHeaders).slice(0, MAX_LIST)) {
        if (!SECRET_KEY_RE.test(String(value || ""))) {
          errors.push(`config.secretHeaders: "${String(key).slice(0, 64)}" must reference a secret by env-var-safe name`);
          continue;
        }
        secretHeaders[String(key).slice(0, 128)] = String(value);
      }
    }
  }
  return { url, method, headers, secretHeaders };
}

function validateVercelPreviewConfig(config, errors, { secretNames }) {
  const project = String(config.project || "").trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(project)) errors.push("config.project is required (letters, digits, . _ -)");
  const teamId = String(config.teamId || "").trim();
  if (teamId && !/^[A-Za-z0-9._-]{1,100}$/.test(teamId)) errors.push("config.teamId contains unsupported characters");
  if (!secretNames.length) errors.push("vercel-preview requires secretNames to reference the deploy token by name");
  return { project, ...(teamId ? { teamId } : {}) };
}

function validateCustomScriptConfig(config, errors, { params }) {
  const command = String(config.command || "").trim();
  if (!isAbsolutePath(command)) errors.push("config.command is required and must be an absolute path");
  const allowedCommandPaths = validateAbsolutePathList(config.allowedCommandPaths, "config.allowedCommandPaths", errors);
  if (command && allowedCommandPaths.length && !allowedCommandPaths.some((root) => command === root || command.startsWith(`${root.replace(/\/$/, "")}/`))) {
    errors.push("config.command must live inside config.allowedCommandPaths");
  }
  const paramNames = new Set(params.map((param) => param.name));
  const argv = [];
  const rawArgv = Array.isArray(config.argv) ? config.argv : config.argv === undefined ? [] : null;
  if (rawArgv === null) errors.push("config.argv must be an array");
  else {
    if (rawArgv.length > MAX_LIST) errors.push(`config.argv: at most ${MAX_LIST} entries`);
    for (const entry of rawArgv.slice(0, MAX_LIST)) {
      // argv entries are execFile-style arguments — there is never a shell, so
      // no user-controlled string is ever interpreted. Literals are
      // admin-authored; dynamic values come only from declared params or the
      // fixed run fields.
      if (typeof entry === "string") {
        if (entry.length > 200 || /[\n\r\0]/.test(entry)) {
          errors.push("config.argv: literal arguments must be short single-line strings");
          continue;
        }
        argv.push(entry);
        continue;
      }
      if (isPlainObject(entry) && typeof entry.param === "string") {
        if (!paramNames.has(entry.param)) {
          errors.push(`config.argv: {param: "${entry.param.slice(0, 64)}"} does not reference a declared param`);
          continue;
        }
        argv.push({ param: entry.param });
        continue;
      }
      if (isPlainObject(entry) && typeof entry.field === "string") {
        if (!["artifactPath", "runId", "runUrl"].includes(entry.field)) {
          errors.push(`config.argv: unsupported field "${entry.field.slice(0, 32)}"`);
          continue;
        }
        argv.push({ field: entry.field });
        continue;
      }
      errors.push("config.argv entries must be literal strings, {param}, or {field} references");
    }
  }
  const cwd = String(config.cwd || "").trim();
  if (cwd && !isAbsolutePath(cwd)) errors.push("config.cwd must be an absolute path");
  const timeoutSeconds = config.timeoutSeconds === undefined ? 600 : Number(config.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    errors.push("config.timeoutSeconds must be between 1 and 3600");
  }
  return {
    command,
    argv,
    ...(cwd ? { cwd } : {}),
    timeoutSeconds: Number.isFinite(timeoutSeconds) ? Math.min(Math.max(timeoutSeconds, 1), 3600) : 600,
    allowedCommandPaths,
    allowedArtifactRoots: validateAbsolutePathList(config.allowedArtifactRoots, "config.allowedArtifactRoots", errors)
  };
}

// Validate an admin-submitted hook profile definition into a bounded,
// normalized shape. Returns { ok, errors, definition }. Error strings name
// offending keys but never echo submitted values beyond short identifiers.
export function validateHookProfileDefinition(input = {}) {
  const errors = [];
  const slug = String(input.slug || "").trim();
  if (!HOOK_SLUG_RE.test(slug)) errors.push("slug is required: lowercase letters, digits, hyphens, max 64 chars");
  const name = String(input.name || "").trim();
  if (!name || name.length > 120) errors.push("name is required (max 120 chars)");
  const description = String(input.description || "").slice(0, 2000);
  const kind = String(input.kind || "").trim();
  if (!HOOK_KINDS.includes(kind)) errors.push(`kind must be one of: ${HOOK_KINDS.join(", ")}`);

  const params = validateParams(input.params ?? [], errors);
  const secretNames = validateSecretNames(input.secretNames ?? input.secret_names ?? [], errors);

  const allowedCapabilities = cleanStringArray(input.allowedCapabilities ?? input.allowed_capabilities);
  if (allowedCapabilities.length > MAX_ALLOWED_CAPABILITIES) {
    errors.push(`allowedCapabilities: at most ${MAX_ALLOWED_CAPABILITIES} entries`);
  }

  const rawConfig = input.config === undefined ? {} : input.config;
  let config = {};
  if (!isPlainObject(rawConfig)) {
    errors.push("config must be an object");
  } else if (JSON.stringify(rawConfig).length > MAX_CONFIG_BYTES) {
    errors.push(`config too large (max ${MAX_CONFIG_BYTES} bytes)`);
  } else if (HOOK_KINDS.includes(kind)) {
    rejectUnknownConfigKeys(kind, rawConfig, errors);
    if (kind === "static-publish") config = validateStaticPublishConfig(rawConfig, errors);
    else if (kind === "git-push") config = validateGitPushConfig(rawConfig, errors);
    else if (kind === "webhook") config = validateWebhookConfig(rawConfig, errors);
    else if (kind === "vercel-preview") config = validateVercelPreviewConfig(rawConfig, errors, { secretNames });
    else if (kind === "custom-script") config = validateCustomScriptConfig(rawConfig, errors, { params });
  }

  const definition = {
    slug,
    name,
    description,
    kind,
    config,
    params,
    secretNames,
    allowedCapabilities: allowedCapabilities.slice(0, MAX_ALLOWED_CAPABILITIES),
    enabled: input.enabled === false || input.enabled === 0 ? false : true
  };
  return { ok: errors.length === 0, errors, definition };
}

// Readiness = "could this profile execute right now": every referenced secret
// must exist in the encrypted store. Reports missing secret NAMES only —
// values never leave storage.
export function hookProfileReadiness(profile, { secretExists, secretsEnabled = () => true } = {}) {
  const required = cleanStringArray(profile?.secretNames);
  if (!required.length) return { ready: true, status: "ready", missingSecrets: [] };
  if (!secretsEnabled()) {
    return {
      ready: false,
      status: HOOK_STATUS_CONFIG_REQUIRED,
      missingSecrets: required,
      message: "secrets store disabled; set SECRETS_ENC_KEY on the Hub"
    };
  }
  const missingSecrets = required.filter((name) => !secretExists(name));
  if (missingSecrets.length) {
    return { ready: false, status: HOOK_STATUS_CONFIG_REQUIRED, missingSecrets };
  }
  return { ready: true, status: "ready", missingSecrets: [] };
}

// Caller-facing shape: enough to select a profile and fill its params, nothing
// about the operator's infrastructure (paths, remotes, URLs, secret names).
export function presentHookProfileForCaller(profile) {
  return {
    slug: profile.slug,
    name: profile.name,
    description: profile.description,
    kind: profile.kind,
    params: profile.params,
    enabled: profile.enabled
  };
}

// Two-sided eligibility: the profile must be enabled, the profile must allow
// the capability (empty allowedCapabilities = any), and the capability must
// opt in via workflow.hooks.allowedProfiles ("*" = any enabled profile the
// profile side permits). Default-closed on the capability side.
export function eligibleHookProfiles({ capability, profiles = [] }) {
  const allowedProfiles = cleanStringArray(capability?.workflow?.hooks?.allowedProfiles);
  if (!allowedProfiles.length) return [];
  const wildcard = allowedProfiles.includes("*");
  return profiles.filter((profile) => {
    if (!profile.enabled) return false;
    const capabilityAllowed = !profile.allowedCapabilities.length
      || profile.allowedCapabilities.includes(capability.slug);
    if (!capabilityAllowed) return false;
    return wildcard || allowedProfiles.includes(profile.slug);
  });
}

export function normalizeHookProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    config: parseJsonField(row.config, {}),
    params: parseJsonField(row.params, []),
    secretNames: parseJsonField(row.secret_names, []),
    allowedCapabilities: parseJsonField(row.allowed_capabilities, []),
    definitionHash: row.definition_hash || "",
    version: row.version,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function hookProfileDefinitionHash(definition) {
  return createHash("sha256").update(stableJsonString(definition)).digest("hex");
}

export function hookProfilePayloadFromDefinition(definition) {
  return {
    slug: definition.slug,
    name: definition.name,
    description: definition.description,
    kind: definition.kind,
    config: jsonField(definition.config, {}),
    params: jsonField(definition.params, []),
    secret_names: jsonField(definition.secretNames, []),
    allowed_capabilities: jsonField(definition.allowedCapabilities, []),
    definition_hash: hookProfileDefinitionHash(definition),
    enabled: definition.enabled ? 1 : 0
  };
}

export function hookProfileInsertQuery() {
  return {
    sql: `INSERT INTO hook_profiles
     (id, slug, name, description, kind, config, params, secret_names, allowed_capabilities,
      definition_hash, version, enabled, created_at, updated_at)
     VALUES ($id, $slug, $name, $description, $kind, $config, $params, $secret_names,
      $allowed_capabilities, $definition_hash, $version, $enabled, $created_at, $updated_at)`
  };
}

export function hookProfileUpdateQuery(payload) {
  return {
    sql: `UPDATE hook_profiles SET name=$name, description=$description, kind=$kind, config=$config,
       params=$params, secret_names=$secret_names, allowed_capabilities=$allowed_capabilities,
       definition_hash=$definition_hash, enabled=$enabled, version=$version, updated_at=$updated_at WHERE slug=$slug`,
    params: payload
  };
}

export function hookProfileListQuery({ includeDisabled = false } = {}) {
  return {
    sql: `SELECT * FROM hook_profiles ${includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY name`,
    params: []
  };
}

export function hookProfileLookupQuery(slugOrId) {
  return {
    sql: "SELECT * FROM hook_profiles WHERE slug = ? OR id = ?",
    params: [slugOrId, slugOrId]
  };
}

export function hookProfileSlugQuery(slug) {
  return {
    sql: "SELECT * FROM hook_profiles WHERE slug = ?",
    params: [slug]
  };
}
