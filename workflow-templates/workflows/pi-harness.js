// Pi harness selection + custom-endpoint config for workflow templates.
//
// RunYard drives OpenAI-compatible custom endpoints (Fugu, Venice, GLM/Z.AI,
// local llama.cpp, ...) through Smithers' native PiAgent: the operator defines
// the endpoint as a Pi provider (baseUrl + api + "$ENV_VAR" apiKey reference in
// `~/.pi/agent/models.json` on the runner host), and RunYard selects it with
// RUNYARD_PI_* env config. The endpoint's API key itself is NEVER part of this
// config and never appears in argv — it reaches the workflow child only through
// the Hub's encrypted per-run secretEnv channel (or the runner host's pi
// config), and Pi resolves it from its own environment.
//
// Config surface (global, with optional per-workflow override):
//   RUNYARD_PI_PROVIDER      provider label matching a pi provider (fugu, venice, zai, ...)
//   RUNYARD_PI_MODEL         model id served by that endpoint
//   RUNYARD_PI_BASE_URL      endpoint URL (informational: pi reads it from models.json;
//                            RunYard surfaces it in diagnostics/docs, not argv)
//   RUNYARD_PI_API_KEY_ENV   NAME of the env var carrying the key (e.g. VENICE_API_KEY)
//   RUNYARD_<WORKFLOW>_PI_*  per-workflow override of any of the above
//   RUNYARD_AGENT_CLI / RUNYARD_<WORKFLOW>_AGENT_CLI
//                            explicit harness selection: "pi" | "claude" | "codex"
//
// When no explicit *_AGENT_CLI selection is made but a Pi endpoint is
// configured, Pi becomes the default harness.

const PI_ENV_SUFFIXES = ["PROVIDER", "MODEL", "BASE_URL", "API_KEY_ENV"];

// "gobbler-comic" / "Gobbler Comic" -> "GOBBLER_COMIC"
export function normalizeWorkflowKey(workflow = "") {
  return String(workflow)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function scopedPiEnv(env, workflowKey, suffix) {
  const scoped = workflowKey ? env[`RUNYARD_${workflowKey}_PI_${suffix}`] : undefined;
  const value = scoped !== undefined && String(scoped).trim() !== "" ? scoped : env[`RUNYARD_PI_${suffix}`];
  return String(value ?? "").trim();
}

// Returns the normalized Pi endpoint config, or null when none is configured.
// `apiKeyConfigured` reports whether the NAMED key variable is actually present
// in `env` (i.e. the secret was delivered) without ever exposing its value.
export function resolvePiEndpoint(env = process.env, { workflow = "" } = {}) {
  const workflowKey = normalizeWorkflowKey(workflow);
  const config = {};
  for (const suffix of PI_ENV_SUFFIXES) {
    config[suffix] = scopedPiEnv(env, workflowKey, suffix);
  }
  if (!config.PROVIDER && !config.MODEL) return null;
  const apiKeyEnv = config.API_KEY_ENV;
  return {
    provider: config.PROVIDER,
    model: config.MODEL,
    baseUrl: config.BASE_URL,
    apiKeyEnv,
    apiKeyConfigured: Boolean(apiKeyEnv && String(env[apiKeyEnv] ?? "").trim() !== "")
  };
}

// Harness selection order: per-workflow env > global env > Pi-by-default when a
// Pi endpoint is configured > the template's own default.
export function resolveAgentCli(env = process.env, { workflow = "", fallback = "claude" } = {}) {
  const workflowKey = normalizeWorkflowKey(workflow);
  const explicit = (workflowKey ? env[`RUNYARD_${workflowKey}_AGENT_CLI`] : "") || env.RUNYARD_AGENT_CLI || "";
  const want = String(explicit).trim().toLowerCase();
  if (want) return want;
  if (resolvePiEndpoint(env, { workflow: workflowKey })) return "pi";
  return String(fallback || "claude").trim().toLowerCase();
}

// Smithers-native PiAgent constructor options for a resolved endpoint. The API
// key deliberately stays OUT of these options: `--api-key` argv is visible in
// process listings, so Pi must resolve the key from its environment via the
// "$ENV_VAR" apiKey reference in models.json.
export function piAgentOptions(endpoint, { cwd, systemPrompt, timeoutMs } = {}) {
  if (!endpoint || (!endpoint.provider && !endpoint.model)) {
    throw new Error(
      "pi harness selected but no Pi endpoint is configured; set RUNYARD_PI_PROVIDER and RUNYARD_PI_MODEL (see docs/pi-custom-endpoints.md)"
    );
  }
  const options = {};
  if (endpoint.provider) options.provider = endpoint.provider;
  if (endpoint.model) options.model = endpoint.model;
  if (cwd) options.cwd = cwd;
  if (systemPrompt) options.systemPrompt = systemPrompt;
  if (timeoutMs) options.timeoutMs = timeoutMs;
  return options;
}

export function createPiAgentFromEnv({ PiAgent, env = process.env, workflow = "", cwd, systemPrompt, timeoutMs } = {}) {
  if (!PiAgent) {
    throw new Error("createPiAgentFromEnv requires the PiAgent constructor from smithers-orchestrator");
  }
  const endpoint = resolvePiEndpoint(env, { workflow });
  return new PiAgent(piAgentOptions(endpoint, { cwd, systemPrompt, timeoutMs }));
}
