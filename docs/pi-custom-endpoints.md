# Pi as the harness for OpenAI-compatible custom endpoints

RunYard workflows are driven by an agent CLI ("harness"). Alongside `claude`
and `codex`, RunYard supports [Pi](https://github.com/badlogic/pi-mono)
(`@mariozechner/pi-coding-agent`) through Smithers' native `PiAgent`. Pi is the
harness of choice for **custom OpenAI-compatible endpoints** — Fugu, Venice,
GLM/Z.AI, OpenRouter, local llama.cpp — because the Pi CLI has a first-class
custom-provider registry, and Smithers keeps its Pi semantics (sessions,
event stream, hijack) instead of a hand-rolled HTTP provider.

When a Pi endpoint is configured and no explicit harness is selected, **Pi is
the default harness**.

## How the pieces fit

1. **Pi CLI on the runner host** defines the endpoint as a provider in
   `~/.pi/agent/models.json`: base URL, wire API, model list, and an
   *environment-variable reference* for the API key.
2. **RunYard selection** picks the provider/model per run or per capability
   (`agentHarness`/`piProvider`/`piModel`/`piApiKeyEnv` in run input or
   capability workflow config; `src/runHarnessSelection.js`), with
   `RUNYARD_PI_*` env config as the install-wide fallback. These are labels
   and names — never credentials — and reach the workflow child through the
   runner's `runEnv` channel plus the child-env allowlist (`src/childEnv.js`,
   `CHILD_ENV_ALLOWLIST_PATTERNS`).
3. **The API key** is stored as a Hub secret with that name and injected
   per-run through the encrypted `secretEnv` channel. Ambient `*_API_KEY`
   variables on the runner host are stripped and never reach workflows; Pi
   resolves `"$VENICE_API_KEY"`-style references from the child environment
   at request time. The key never appears in argv (`--api-key` is not used).
4. **Workflow templates** build a `PiAgent({ provider, model, cwd,
   systemPrompt, timeoutMs })` primary with the existing claude→codex pair as
   fallback, so an endpoint outage or a missing `pi` binary degrades instead
   of failing the run.

## Setup

### 1. Install Pi on the runner host

```bash
npm install -g @mariozechner/pi-coding-agent   # provides `pi` on PATH
pi --version
```

`runyard runner setup` reports `pi` in its prerequisites line.

### 2. Define the endpoint as a Pi provider

`~/.pi/agent/models.json` on the runner host (the `apiKey` entries are
`$ENV_VAR` references, not literal keys):

```json
{
  "providers": {
    "fugu": {
      "baseUrl": "https://api.fugu.example/v1",
      "api": "openai-completions",
      "apiKey": "$FUGU_API_KEY",
      "models": [
        { "id": "fugu-large", "name": "Fugu Large", "contextWindow": 128000, "maxTokens": 16384 }
      ]
    },
    "venice": {
      "baseUrl": "https://api.venice.ai/api/v1",
      "api": "openai-completions",
      "apiKey": "$VENICE_API_KEY",
      "models": [
        { "id": "llama-3.3-70b", "name": "Llama 3.3 70B", "contextWindow": 65536, "maxTokens": 8192 }
      ]
    },
    "glm": {
      "baseUrl": "https://api.z.ai/api/paas/v4",
      "api": "openai-completions",
      "apiKey": "$ZAI_API_KEY",
      "models": [
        { "id": "glm-4.7", "name": "GLM 4.7", "contextWindow": 200000, "maxTokens": 16384 }
      ]
    }
  }
}
```

### 3. Store ALL the API keys as Hub secrets — once

Create one secret per endpoint, named exactly like its `$ENV_VAR` reference
(`FUGU_API_KEY`, `VENICE_API_KEY`, `ZAI_API_KEY`, ...) on the Hub Secrets page
(requires `SECRETS_ENC_KEY`). Keys are set up once and then *selected* per
run or per capability — you never edit runner environment to switch
providers. A key reaches a workflow child only through the encrypted per-run
`secretEnv` channel, and only when that run asked for it by name: via the
capability's `workflow.secrets`, the run input's `secretNames`, or the run's
`piApiKeyEnv` selection (below).

### 4. Pick per run / per workflow

With every key stored, each run or capability selects its harness and
endpoint **by name**. Run input fields (validated by the runner; labels and
env-var names only, never credentials):

```jsonc
// This run uses Venice; VENICE_API_KEY is delivered automatically.
{
  "prompt": "Refactor the parser",
  "agentHarness": "pi",            // optional: "pi" | "claude" | "codex"
  "piProvider": "venice",
  "piModel": "llama-3.3-70b",
  "piApiKeyEnv": "VENICE_API_KEY"  // NAME of the Hub secret / env var
}
```

```jsonc
// The next run switches to GLM — same capability, no env edits anywhere.
{
  "prompt": "Audit the contract",
  "piProvider": "glm",
  "piModel": "glm-4.7",
  "piApiKeyEnv": "ZAI_API_KEY"
}
```

```jsonc
// Explicit claude/codex still overrides any Pi default for one run.
{ "prompt": "Quick fix", "agentHarness": "codex" }
```

The same fields work as capability defaults in the capability's `workflow`
config (run input wins field-wise):

```jsonc
// capability.workflow
{
  "entry": "workflows/smart-contract-audit.tsx",
  "agentHarness": "pi",
  "piProvider": "glm",
  "piModel": "glm-4.7",
  "piApiKeyEnv": "ZAI_API_KEY"
}
```

Naming `piApiKeyEnv` implies delivery of exactly that Hub secret (same trust
model as `input.secretNames`, which already lets a run request secrets by
name). Selecting a key that was never stored fails cleanly: the Pi primary's
first call reports `selects api key env VENICE_API_KEY, but that variable is
not present in this environment` — name only, never a value — and the run
degrades to the claude→codex pair. A malformed selection (bad harness name,
a key *value* pasted where a key *name* belongs) fails preflight without
echoing the offending value.

The runner injects the selection into the workflow child as `RUNYARD_RUN_*`
variables (`RUNYARD_RUN_AGENT_CLI`, `RUNYARD_RUN_PI_PROVIDER`,
`RUNYARD_RUN_PI_MODEL`, `RUNYARD_RUN_PI_BASE_URL`,
`RUNYARD_RUN_PI_API_KEY_ENV`), which outrank all ambient env config below.

### 5. Env defaults (optional fallback)

Existing installs keep working unchanged: runner (or hub-managed runner)
environment remains the fallback when a run/capability selects nothing.

```bash
# Global: every workflow defaults to Pi on this endpoint
RUNYARD_PI_PROVIDER=venice
RUNYARD_PI_MODEL=llama-3.3-70b
RUNYARD_PI_BASE_URL=https://api.venice.ai/api/v1   # informational/diagnostics
RUNYARD_PI_API_KEY_ENV=VENICE_API_KEY
```

Selection precedence (`resolveAgentCli` in
`workflow-templates/workflows/pi-harness.js`):

1. `RUNYARD_RUN_AGENT_CLI` — the run's own selection (`agentHarness` in run
   input or capability workflow config, injected by the runner)
2. `RUNYARD_<WORKFLOW>_AGENT_CLI` (e.g. `RUNYARD_IMPLEMENT_AGENT_CLI=codex`)
3. `RUNYARD_AGENT_CLI` (`pi` | `claude` | `codex`)
4. `pi`, if a Pi endpoint is configured (this is what makes Pi the default)
5. the template's built-in default (`codex` for implement, `claude` elsewhere)

Endpoint fields resolve the same way, field-wise: `RUNYARD_RUN_PI_*` >
`RUNYARD_<WORKFLOW>_PI_*` > `RUNYARD_PI_*`. (`RUN` is a reserved workflow
key.)

Per-workflow endpoint overrides follow the same shape:

```bash
# Implementation runs on GLM, everything else stays on the global endpoint
RUNYARD_IMPLEMENT_PI_PROVIDER=glm
RUNYARD_IMPLEMENT_PI_MODEL=glm-4.7
RUNYARD_IMPLEMENT_PI_API_KEY_ENV=ZAI_API_KEY
```

Workflow keys: `IMPLEMENT`, `IMPROVE`, `SUPPORT`, `IDEA`, `PRODUCT`,
`KNOWLEDGE`, `AUDIT`, `APP_SKINNER`, `WORKFLOW_DOCTOR`, `GOBBLER_COMIC`.

## Fallback behavior

The Pi primary wraps the existing claude→codex fallback pair: auth/quota/rate
errors from the endpoint, and a missing `pi` binary (spawn `ENOENT`), retry
once on the CLI pair with CLI-specific resume state cleared
(`workflow-templates/workflows/agent-fallback.js`). A selected-but-undelivered
endpoint key also degrades: the Pi primary's first call fails with a clean,
name-only message and the CLI pair takes over. A Pi selection without any
provider/model config at all fails fast at template load with a pointer to
this document.

## Security notes

- `RUNYARD_PI_API_KEY_ENV` / `piApiKeyEnv` carry the *name* of the key
  variable. Anything ending in `API_KEY`, `TOKEN`, or `SECRET` matches none
  of the child-env passthrough patterns; keys ride the encrypted per-run
  `secretEnv` channel.
- Run/capability selection fields are validated by the runner: a value that
  is not label-shaped (e.g. a pasted key where a name belongs) fails
  preflight, and the error never echoes the value.
- The key is never passed as `--api-key` argv (visible in process listings);
  Pi reads it from its environment via the `models.json` reference.
- Do not put literal keys in `models.json`. `$ENV_VAR` references keep the
  file shareable and the key out of disk state.
