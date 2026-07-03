// Per-run / per-capability harness selection.
//
// "Set up all the keys once, pick and choose as needed": operators store every
// endpoint key (VENICE_API_KEY, ZAI_API_KEY, FUGU_API_KEY, ...) as a Hub secret
// once, and each run or capability then SELECTS a harness/endpoint by name —
// no runner-environment edit per switch. The selection surface carries labels
// and env-var NAMES only, never credentials:
//
//   input.agentHarness / capability.workflow.agentHarness   "pi" | "claude" | "codex"
//   input.piProvider   / capability.workflow.piProvider     pi provider label (venice, glm, fugu, ...)
//   input.piModel      / capability.workflow.piModel        model id on that endpoint
//   input.piBaseUrl    / capability.workflow.piBaseUrl      endpoint URL (diagnostics only)
//   input.piApiKeyEnv  / capability.workflow.piApiKeyEnv    NAME of the env var carrying the key
//
// Field-wise precedence: run input > capability workflow config. The runner
// turns the resolved selection into RUNYARD_RUN_* child-env variables, which
// the workflow templates (pi-harness.js) rank above the runner's ambient
// RUNYARD_<WORKFLOW>_PI_* / RUNYARD_PI_* env — so env config remains the
// default and per-run selection cleanly overrides it.
//
// The named key still travels ONLY through the Hub's encrypted per-run
// secretEnv channel: secretNamesForRun() adds the selected piApiKeyEnv to the
// run's secret-name allowlist, and childEnv strips ambient runner keys as
// before. A selection can name a key; it can never carry one.

export const HARNESS_CHOICES = new Set(["pi", "claude", "codex"]);

export const HARNESS_SELECTION_FIELDS = ["agentHarness", "piProvider", "piModel", "piBaseUrl", "piApiKeyEnv"];

const FIELD_ENV_NAMES = {
  agentHarness: "RUNYARD_RUN_AGENT_CLI",
  piProvider: "RUNYARD_RUN_PI_PROVIDER",
  piModel: "RUNYARD_RUN_PI_MODEL",
  piBaseUrl: "RUNYARD_RUN_PI_BASE_URL",
  piApiKeyEnv: "RUNYARD_RUN_PI_API_KEY_ENV"
};

// Labels are short identifier-ish strings; model ids may carry "/" (openrouter)
// and ":" (ollama-style tags). Anything longer or stranger is not a label.
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const BASE_URL_PATTERN = /^https?:\/\/\S{1,500}$/;

// Validation messages deliberately never echo the rejected value: a careless
// caller may paste a literal key into piApiKeyEnv, and that mistake must not
// end up in run events/logs.
const FIELD_RULES = {
  agentHarness: {
    ok: (value) => HARNESS_CHOICES.has(value.toLowerCase()),
    normalize: (value) => value.toLowerCase(),
    expected: 'one of "pi", "claude", "codex"'
  },
  piProvider: { ok: (value) => LABEL_PATTERN.test(value), expected: "a short provider label (letters, digits, ._:/-)" },
  piModel: { ok: (value) => LABEL_PATTERN.test(value), expected: "a short model id (letters, digits, ._:/-)" },
  piBaseUrl: { ok: (value) => BASE_URL_PATTERN.test(value), expected: "an http(s):// URL" },
  piApiKeyEnv: {
    ok: (value) => ENV_NAME_PATTERN.test(value),
    expected: "an environment variable NAME like VENICE_API_KEY (uppercase letters, digits, underscores) — never the key itself"
  }
};

function fieldValue(source, field) {
  const raw = source?.[field];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value === "" ? undefined : value;
}

// Resolve the effective harness selection for a run: field-wise, run input
// wins over the capability's workflow config. Returns { selection, issues };
// invalid fields are dropped from the selection and reported as issues (field
// name + expected shape, never the offending value).
export function resolveHarnessSelection({ capability, input } = {}) {
  const workflowConfig = capability?.workflow && typeof capability.workflow === "object" ? capability.workflow : {};
  const runInput = input && typeof input === "object" ? input : {};
  const selection = {};
  const issues = [];
  for (const field of HARNESS_SELECTION_FIELDS) {
    const fromInput = fieldValue(runInput, field);
    const value = fromInput !== undefined ? fromInput : fieldValue(workflowConfig, field);
    if (value === undefined) continue;
    const source = fromInput !== undefined ? "run input" : "capability workflow config";
    const rule = FIELD_RULES[field];
    if (!rule.ok(value)) {
      issues.push(`harness selection field "${field}" (${source}) must be ${rule.expected}`);
      continue;
    }
    selection[field] = rule.normalize ? rule.normalize(value) : value;
  }
  return { selection, issues };
}

// Child-env variables for a resolved selection. These ride the runner's runEnv
// channel (names/labels only) and outrank ambient RUNYARD_* env inside
// pi-harness.js resolution.
export function harnessSelectionRunEnv(selection = {}) {
  const env = {};
  for (const field of HARNESS_SELECTION_FIELDS) {
    if (selection[field]) env[FIELD_ENV_NAMES[field]] = selection[field];
  }
  return env;
}

// The secret NAME a selection asks the Hub to deliver (alongside
// workflow.secrets / input.secretNames). Empty when no key env is selected.
export function harnessSelectionSecretNames(selection = {}) {
  return selection.piApiKeyEnv ? [selection.piApiKeyEnv] : [];
}
