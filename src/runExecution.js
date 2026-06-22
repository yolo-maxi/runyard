const LOCAL_ALIASES = new Set(["local", "laptop", "workstation", "desktop", "self"]);
const REMOTE_ALIASES = new Set(["remote", "vps", "server", "worker", "pool", "hetzner", "cloud"]);
const AUTO_ALIASES = new Set(["", "auto", "any", "default"]);

export const DEFAULT_REMOTE_RUNNER_LOCATION = "vps";

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

function cleanTag(value) {
  return clean(value).replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeExecutionMode(value) {
  const raw = clean(value);
  if (AUTO_ALIASES.has(raw)) return "auto";
  if (LOCAL_ALIASES.has(raw)) return "local";
  if (REMOTE_ALIASES.has(raw)) return "remote";
  return "auto";
}

export function normalizeRunnerLocation(value, mode = "auto") {
  const raw = cleanTag(value);
  if (!raw) {
    if (mode === "local") return "local";
    if (mode === "remote") return DEFAULT_REMOTE_RUNNER_LOCATION;
    return "";
  }
  if (LOCAL_ALIASES.has(raw)) return "local";
  if (REMOTE_ALIASES.has(raw)) return DEFAULT_REMOTE_RUNNER_LOCATION;
  return raw;
}

export function normalizeExecutionIntent(input = {}, options = {}) {
  const nested = options.execution && typeof options.execution === "object" && !Array.isArray(options.execution)
    ? options.execution
    : {};
  const stored = input?.__execution && typeof input.__execution === "object" && !Array.isArray(input.__execution)
    ? input.__execution
    : {};

  let mode = normalizeExecutionMode(
    options.executionMode ?? options.where ?? nested.mode ?? nested.executionMode ?? stored.mode ?? stored.executionMode
  );
  const runnerLocation = normalizeRunnerLocation(
    options.runnerLocation ?? options.executionLocation ?? nested.runnerLocation ?? nested.location ?? stored.runnerLocation ?? stored.location,
    mode
  );

  if (mode === "auto" && runnerLocation === "local") mode = "local";
  if (mode === "auto" && runnerLocation === DEFAULT_REMOTE_RUNNER_LOCATION) mode = "remote";

  const requested = mode !== "auto" || Boolean(runnerLocation);
  return {
    mode,
    runnerLocation,
    requested,
    sourceOfTruth: "hub",
    outputs: "hub",
    artifacts: "hub"
  };
}

export function executionIntentFromInput(input = {}) {
  return normalizeExecutionIntent(input, input?.__execution || {});
}

export function storeExecutionIntent(input = {}, intent = {}) {
  if (!intent?.requested) return input;
  return {
    ...input,
    __execution: {
      mode: intent.mode,
      runnerLocation: intent.runnerLocation,
      requested: true,
      sourceOfTruth: "hub",
      outputs: "hub",
      artifacts: "hub"
    }
  };
}

export function executionIntentMatchesRunnerTags(intent = {}, tags = []) {
  if (!intent?.requested || !intent.runnerLocation) return true;
  const normalized = new Set((tags || []).map(cleanTag).filter(Boolean));
  const location = normalizeRunnerLocation(intent.runnerLocation, intent.mode);
  if (!location) return true;
  if (location === DEFAULT_REMOTE_RUNNER_LOCATION) {
    return normalized.has(DEFAULT_REMOTE_RUNNER_LOCATION) || normalized.has("remote");
  }
  return normalized.has(location);
}

// Capability version pinning + rollback (RUNYARD_CAPABILITY_VERSIONING).
// Run creation in db.js takes optional `capabilitySha` / `parentRunId` options
// and writes them into the new nullable columns. Both helpers below are the
// single choke point that decides "is the flag on?" — when it's off the
// caller-supplied values are dropped and the columns persist as NULL, leaving
// the legacy path (and every existing test) byte-for-byte unchanged.
export function capabilityVersioningEnabled(env = process.env) {
  return String(env?.RUNYARD_CAPABILITY_VERSIONING || "").trim() === "1";
}

// Returns `{ capabilitySha, parentRunId }` already gated by the flag, so the
// caller can spread them straight into createRun options. Either field is null
// when the flag is off or when nothing meaningful was provided.
export function resolveCapabilityVersionOptions(input = {}, env = process.env) {
  if (!capabilityVersioningEnabled(env)) {
    return { capabilitySha: null, parentRunId: null };
  }
  const capabilitySha = input?.capabilitySha ? String(input.capabilitySha).trim() || null : null;
  const parentRunId = input?.parentRunId ? String(input.parentRunId).trim() || null : null;
  return { capabilitySha, parentRunId };
}

export function normalizeRunnerTags(tags = [], location = "") {
  const out = [];
  const seen = new Set();
  const add = (tag) => {
    const cleaned = cleanTag(tag);
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  for (const tag of tags) add(tag);
  const normalizedLocation = normalizeRunnerLocation(location, normalizeExecutionMode(location));
  if (normalizedLocation) add(normalizedLocation);
  if (normalizedLocation === DEFAULT_REMOTE_RUNNER_LOCATION) add("remote");
  return out;
}
