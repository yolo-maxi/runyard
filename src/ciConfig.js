import { parse as parseYaml } from "yaml";
import { CI_EXECUTORS } from "./ciRecords.js";

// `.runyard/ci.yml` — the deliberately small, versioned CI configuration
// schema (specs/ci-platform.md). This module owns parsing, validation, DAG
// checks, deterministic trigger matching, and the concurrency key. It is
// pure: no I/O, no DB. The config ALWAYS comes from a trusted revision
// (push: the pushed commit; PR: the base branch head) — enforced by the
// caller (src/ciTriggers.js), which pins the exact source SHA.

export const CI_CONFIG_PATH = ".runyard/ci.yml";
export const CI_CONFIG_MAX_BYTES = 128 * 1024;

const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_JOBS = 20;
const MAX_COMMANDS = 50;
const MAX_COMMAND_CHARS = 4000;
const MAX_ENV_VARS = 50;
const MAX_ENV_VALUE_CHARS = 4096;
const MAX_SECRETS = 20;
const MAX_ARTIFACT_GLOBS = 20;
const MAX_FILTER_PATTERNS = 50;
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_TIMEOUT_MINUTES = 360;

// --- deterministic glob matching -------------------------------------------
// Supported: `*` (within a segment), `**` (across segments), `?` (one char).
// No brace expansion, no extglobs, no negation — deterministic by design.
export function globToRegExp(pattern) {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` and `**` cross segment boundaries.
        regex += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 2 : 1;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`);
}

export function matchesAnyGlob(value, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

// --- validation -------------------------------------------------------------

function fail(errors) {
  return { ok: false, errors };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStringList(value, { label, max, maxChars = 512, pattern = null, patternLabel = "" }, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings`);
    return [];
  }
  if (value.length > max) {
    errors.push(`${label} allows at most ${max} entries`);
    return [];
  }
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      errors.push(`${label} entries must be non-empty strings`);
      return [];
    }
    if (entry.length > maxChars) {
      errors.push(`${label} entry is too long (max ${maxChars} chars)`);
      return [];
    }
    if (pattern && !pattern.test(entry)) {
      errors.push(`${label} entry '${entry}' ${patternLabel}`);
      return [];
    }
    out.push(entry);
  }
  return out;
}

// A repo-relative path or glob: never absolute, never escaping the checkout.
function validateRepoRelative(value, label, errors) {
  if (value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value)) {
    errors.push(`${label} must be repo-relative (got absolute path '${value}')`);
    return false;
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    errors.push(`${label} must not contain '..' (got '${value}')`);
    return false;
  }
  if (value.includes("\0")) {
    errors.push(`${label} contains an invalid character`);
    return false;
  }
  return true;
}

function validateTriggerFilters(raw, eventLabel, errors) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return {};
  if (!isPlainObject(raw)) {
    errors.push(`on.${eventLabel} must be true or an object of filters`);
    return null;
  }
  const filters = {};
  for (const key of Object.keys(raw)) {
    if (!["branches", "tags", "paths"].includes(key)) {
      errors.push(`on.${eventLabel}.${key} is not a supported filter (branches, tags, paths)`);
      return null;
    }
  }
  const listOptions = { max: MAX_FILTER_PATTERNS, maxChars: 256 };
  if (raw.branches !== undefined) {
    filters.branches = validateStringList(raw.branches, { label: `on.${eventLabel}.branches`, ...listOptions }, errors);
    filters.branches.forEach((p) => validateRepoRelative(p, `on.${eventLabel}.branches pattern`, errors));
  }
  if (raw.tags !== undefined) {
    if (eventLabel !== "push") {
      errors.push(`on.${eventLabel}.tags is only supported for push triggers`);
      return null;
    }
    filters.tags = validateStringList(raw.tags, { label: `on.${eventLabel}.tags`, ...listOptions }, errors);
  }
  if (raw.paths !== undefined) {
    filters.paths = validateStringList(raw.paths, { label: `on.${eventLabel}.paths`, ...listOptions }, errors);
    filters.paths.forEach((p) => validateRepoRelative(p, `on.${eventLabel}.paths pattern`, errors));
  }
  return filters;
}

function validateJob(jobName, raw, errors) {
  const prefix = `jobs.${jobName}`;
  if (!JOB_ID_PATTERN.test(jobName)) {
    errors.push(`job id '${jobName}' must match ${JOB_ID_PATTERN} (lowercase, digits, - and _)`);
    return null;
  }
  if (!isPlainObject(raw)) {
    errors.push(`${prefix} must be an object`);
    return null;
  }
  const executor = raw.executor === undefined ? "native" : raw.executor;
  if (!CI_EXECUTORS.includes(executor)) {
    errors.push(`${prefix}.executor must be one of ${CI_EXECUTORS.join(", ")}`);
    return null;
  }

  const job = { jobName, executor, needs: [], required: raw.required !== false, spec: {} };

  job.needs = validateStringList(raw.needs, { label: `${prefix}.needs`, max: MAX_JOBS, pattern: JOB_ID_PATTERN, patternLabel: "is not a valid job id" }, errors);

  if (executor === "native") {
    if (raw.dagger !== undefined) errors.push(`${prefix}: 'dagger' is only valid with executor: dagger`);
    const commands = validateStringList(raw.commands, { label: `${prefix}.commands`, max: MAX_COMMANDS, maxChars: MAX_COMMAND_CHARS }, errors);
    if (!commands.length) errors.push(`${prefix}.commands must list at least one command`);
    job.spec.commands = commands;
  } else {
    if (raw.commands !== undefined) errors.push(`${prefix}: 'commands' is only valid with executor: native`);
    if (!isPlainObject(raw.dagger)) {
      errors.push(`${prefix}.dagger must be an object ({ module, function, args? })`);
    } else {
      const module = typeof raw.dagger.module === "string" && raw.dagger.module.trim() ? raw.dagger.module.trim() : ".";
      const fn = typeof raw.dagger.function === "string" ? raw.dagger.function.trim() : "";
      if (!validateRepoRelative(module, `${prefix}.dagger.module`, errors)) return null;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(fn)) {
        errors.push(`${prefix}.dagger.function must be a function name`);
      }
      const args = {};
      if (raw.dagger.args !== undefined) {
        if (!isPlainObject(raw.dagger.args) || Object.keys(raw.dagger.args).length > 20) {
          errors.push(`${prefix}.dagger.args must be an object with at most 20 entries`);
        } else {
          for (const [key, value] of Object.entries(raw.dagger.args)) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(key) || !["string", "number", "boolean"].includes(typeof value)) {
              errors.push(`${prefix}.dagger.args.${key} must be a string/number/boolean value`);
            } else {
              args[key] = value;
            }
          }
        }
      }
      job.spec.dagger = { module, function: fn, args };
    }
  }

  if (raw.workingDir !== undefined) {
    if (typeof raw.workingDir !== "string" || !raw.workingDir.trim()) {
      errors.push(`${prefix}.workingDir must be a non-empty repo-relative path`);
    } else if (validateRepoRelative(raw.workingDir.trim(), `${prefix}.workingDir`, errors)) {
      job.spec.workingDir = raw.workingDir.trim();
    }
  }

  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env) || Object.keys(raw.env).length > MAX_ENV_VARS) {
      errors.push(`${prefix}.env must be an object with at most ${MAX_ENV_VARS} entries`);
    } else {
      const env = {};
      for (const [name, value] of Object.entries(raw.env)) {
        if (!ENV_NAME_PATTERN.test(name)) {
          errors.push(`${prefix}.env name '${name}' must match ${ENV_NAME_PATTERN}`);
        } else if (!["string", "number", "boolean"].includes(typeof value) || String(value).length > MAX_ENV_VALUE_CHARS) {
          errors.push(`${prefix}.env.${name} must be a short scalar value`);
        } else {
          env[name] = String(value);
        }
      }
      job.spec.env = env;
    }
  }

  job.spec.secrets = validateStringList(
    raw.secrets,
    { label: `${prefix}.secrets`, max: MAX_SECRETS, pattern: SECRET_NAME_PATTERN, patternLabel: "is not a valid secret name" },
    errors
  );

  const timeout = raw.timeoutMinutes === undefined ? DEFAULT_TIMEOUT_MINUTES : raw.timeoutMinutes;
  if (!Number.isFinite(Number(timeout)) || Number(timeout) < 1 || Number(timeout) > MAX_TIMEOUT_MINUTES) {
    errors.push(`${prefix}.timeoutMinutes must be between 1 and ${MAX_TIMEOUT_MINUTES}`);
  } else {
    job.spec.timeoutMinutes = Math.floor(Number(timeout));
  }

  job.spec.artifacts = validateStringList(raw.artifacts, { label: `${prefix}.artifacts`, max: MAX_ARTIFACT_GLOBS, maxChars: 256 }, errors);
  job.spec.artifacts.forEach((glob) => validateRepoRelative(glob, `${prefix}.artifacts glob`, errors));

  return job;
}

// Cycle/unknown-reference check via Kahn's topological sort.
export function validateJobDag(jobs) {
  const errors = [];
  const names = new Set(jobs.map((job) => job.jobName));
  for (const job of jobs) {
    for (const need of job.needs) {
      if (!names.has(need)) errors.push(`jobs.${job.jobName}.needs references unknown job '${need}'`);
      if (need === job.jobName) errors.push(`jobs.${job.jobName} cannot need itself`);
    }
  }
  if (errors.length) return errors;
  const indegree = new Map(jobs.map((job) => [job.jobName, job.needs.length]));
  const dependents = new Map(jobs.map((job) => [job.jobName, []]));
  for (const job of jobs) for (const need of job.needs) dependents.get(need).push(job.jobName);
  const queue = jobs.filter((job) => !job.needs.length).map((job) => job.jobName);
  let visited = 0;
  while (queue.length) {
    const name = queue.shift();
    visited += 1;
    for (const dependent of dependents.get(name)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  if (visited !== jobs.length) errors.push("jobs form a dependency cycle");
  return errors;
}

// Parse + validate the whole file. Returns { ok, config, errors }. Errors are
// operator-legible strings surfaced through API/UI/CLI verbatim.
export function parseCiConfig(text) {
  const errors = [];
  if (typeof text !== "string" || !text.trim()) return fail(["config is empty"]);
  if (Buffer.byteLength(text, "utf8") > CI_CONFIG_MAX_BYTES) {
    return fail([`config exceeds ${CI_CONFIG_MAX_BYTES} bytes`]);
  }
  let raw;
  try {
    raw = parseYaml(text, { maxAliasCount: 20 });
  } catch (error) {
    return fail([`invalid YAML: ${error.message}`]);
  }
  if (!isPlainObject(raw)) return fail(["config must be a YAML mapping"]);
  if (raw.version !== 1) return fail(["version must be 1 (the only supported schema version)"]);

  const name = raw.name === undefined ? "ci" : String(raw.name || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) errors.push("name must be a short lowercase identifier");

  if (!isPlainObject(raw.on) || !Object.keys(raw.on).length) {
    errors.push("on must declare at least one trigger (push, pull_request, manual)");
  }
  const on = {};
  if (isPlainObject(raw.on)) {
    for (const key of Object.keys(raw.on)) {
      if (!["push", "pull_request", "manual"].includes(key)) {
        errors.push(`on.${key} is not a supported trigger (push, pull_request, manual)`);
        continue;
      }
      if (key === "manual") {
        if (typeof raw.on.manual !== "boolean") errors.push("on.manual must be true or false");
        else on.manual = raw.on.manual;
        continue;
      }
      const filters = validateTriggerFilters(raw.on[key], key, errors);
      if (filters !== null) on[key] = filters;
    }
  }
  // Manual dispatch defaults ON — it is the dogfood/recovery path.
  if (on.manual === undefined) on.manual = true;

  let concurrency = { group: "", cancelInProgress: true };
  if (raw.concurrency !== undefined) {
    if (!isPlainObject(raw.concurrency)) {
      errors.push("concurrency must be an object ({ group?, cancelInProgress? })");
    } else {
      if (raw.concurrency.group !== undefined) {
        if (typeof raw.concurrency.group !== "string" || raw.concurrency.group.length > 128) {
          errors.push("concurrency.group must be a literal string (max 128 chars; no expressions)");
        } else {
          concurrency.group = raw.concurrency.group.trim();
        }
      }
      if (raw.concurrency.cancelInProgress !== undefined) {
        if (typeof raw.concurrency.cancelInProgress !== "boolean") errors.push("concurrency.cancelInProgress must be a boolean");
        else concurrency.cancelInProgress = raw.concurrency.cancelInProgress;
      }
    }
  }

  if (!isPlainObject(raw.jobs) || !Object.keys(raw.jobs).length) {
    errors.push("jobs must define at least one job");
    return fail(errors);
  }
  const jobNames = Object.keys(raw.jobs);
  if (jobNames.length > MAX_JOBS) errors.push(`at most ${MAX_JOBS} jobs are supported`);
  const jobs = [];
  for (const jobName of jobNames) {
    const job = validateJob(jobName, raw.jobs[jobName], errors);
    if (job) jobs.push(job);
  }
  errors.push(...validateJobDag(jobs));

  if (errors.length) return fail(errors);
  return { ok: true, config: { version: 1, name, on, concurrency, jobs }, errors: [] };
}

// --- trigger matching -------------------------------------------------------

function refKind(ref) {
  if (ref.startsWith("refs/tags/")) return { kind: "tag", short: ref.slice("refs/tags/".length) };
  if (ref.startsWith("refs/heads/")) return { kind: "branch", short: ref.slice("refs/heads/".length) };
  return { kind: "branch", short: ref };
}

// Deterministic: does this validated config fire for this trigger?
// trigger: { event: 'push'|'pull_request'|'manual', ref, baseRef?, changedPaths? }
// Path filters apply only where the provider reports changed files (push);
// pull_request path filtering is a documented v1 follow-up.
export function ciConfigMatches(config, trigger) {
  if (trigger.event === "manual") {
    return config.on.manual ? { matched: true } : { matched: false, reason: "manual dispatch disabled in config" };
  }
  if (trigger.event === "push") {
    const filters = config.on.push;
    if (!filters) return { matched: false, reason: "no push trigger configured" };
    const { kind, short } = refKind(trigger.ref || "");
    if (kind === "tag") {
      if (!filters.tags?.length) return { matched: false, reason: "no tag filters configured" };
      if (!matchesAnyGlob(short, filters.tags)) return { matched: false, reason: `tag '${short}' matches no filter` };
    } else {
      // Branch pushes: an explicit branches list is authoritative; when only
      // tag filters exist, branch pushes do not fire.
      if (filters.branches?.length) {
        if (!matchesAnyGlob(short, filters.branches)) return { matched: false, reason: `branch '${short}' matches no filter` };
      } else if (filters.tags?.length) {
        return { matched: false, reason: "push trigger only fires for tags" };
      }
    }
    // Path filters gate BRANCH pushes only: a tag names a commit, it does not
    // carry a meaningful changed-file diff.
    if (kind === "branch" && filters.paths?.length) {
      const changed = trigger.changedPaths || [];
      if (!changed.some((file) => matchesAnyGlob(file, filters.paths))) {
        return { matched: false, reason: "no changed path matches the path filters" };
      }
    }
    return { matched: true };
  }
  if (trigger.event === "pull_request") {
    const filters = config.on.pull_request;
    if (!filters) return { matched: false, reason: "no pull_request trigger configured" };
    if (filters.branches?.length) {
      const { short } = refKind(trigger.baseRef || "");
      if (!matchesAnyGlob(short, filters.branches)) {
        return { matched: false, reason: `target branch '${short}' matches no filter` };
      }
    }
    return { matched: true };
  }
  return { matched: false, reason: `unsupported event '${trigger.event}'` };
}

// Concurrency key: newer pipelines cancel-supersede older active ones with
// the same key (when cancelInProgress). Deterministic, low-cardinality-ish:
// repo + event class + ref/PR (or the config's literal group).
export function ciConcurrencyKey({ repoFullName, config, trigger }) {
  if (config?.concurrency?.group) return `${repoFullName}:${config.concurrency.group}`;
  if (trigger.event === "pull_request") return `${repoFullName}:pr/${trigger.prNumber}`;
  return `${repoFullName}:${trigger.event}/${trigger.ref || ""}`;
}
