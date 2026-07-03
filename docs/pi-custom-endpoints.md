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
2. **RunYard env config** (`RUNYARD_PI_*`) selects that provider/model for
   workflows and names the key variable. These are labels and names — never
   credentials — and the runner's child-env allowlist passes exactly this
   family through to the workflow child (`src/childEnv.js`,
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

### 3. Store the API key as a Hub secret

Create a secret named exactly like the `$ENV_VAR` reference (e.g.
`VENICE_API_KEY`) on the Hub Secrets page (requires `SECRETS_ENC_KEY`), and
list it in the capability's `workflow.secrets` or pass it via the run input's
`secretNames`. That is the only supported path for the key to reach a
workflow child.

### 4. Select the harness

Runner (or hub-managed runner) environment:

```bash
# Global: every workflow defaults to Pi on this endpoint
RUNYARD_PI_PROVIDER=venice
RUNYARD_PI_MODEL=llama-3.3-70b
RUNYARD_PI_BASE_URL=https://api.venice.ai/api/v1   # informational/diagnostics
RUNYARD_PI_API_KEY_ENV=VENICE_API_KEY
```

Selection precedence per workflow (`resolveAgentCli` in
`workflow-templates/workflows/pi-harness.js`):

1. `RUNYARD_<WORKFLOW>_AGENT_CLI` (e.g. `RUNYARD_IMPLEMENT_AGENT_CLI=codex`)
2. `RUNYARD_AGENT_CLI` (`pi` | `claude` | `codex`)
3. `pi`, if a Pi endpoint is configured (this is what makes Pi the default)
4. the template's built-in default (`codex` for implement, `claude` elsewhere)

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
(`workflow-templates/workflows/agent-fallback.js`). A Pi selection without
any `RUNYARD_PI_PROVIDER`/`RUNYARD_PI_MODEL` config fails fast at template
load with a pointer to this document.

## Security notes

- `RUNYARD_PI_API_KEY_ENV` carries the *name* of the key variable. Anything
  ending in `API_KEY`, `TOKEN`, or `SECRET` matches none of the child-env
  passthrough patterns; keys ride the encrypted per-run `secretEnv` channel.
- The key is never passed as `--api-key` argv (visible in process listings);
  Pi reads it from its environment via the `models.json` reference.
- Do not put literal keys in `models.json`. `$ENV_VAR` references keep the
  file shareable and the key out of disk state.
