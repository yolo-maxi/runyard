# Rename status: `smithers-hub` → RunYard

Rebrand of **our product** (hub control plane + runner + UI) from `smithers-hub`
to **RunYard**, while leaving the **upstream Smithers engine** we shell out to
untouched.

## Result

- `pnpm test` → **388 pass / 0 fail** (unchanged from baseline).
- `pnpm build:vendor` and `pnpm build:web` → clean.
- `pnpm start` → `/healthz` ok; `/api/version` reports `{"name":"runyard","instanceName":"Runyard"}`.
- Verified back-compat boot: legacy `SMITHERS_HUB_*` env vars still work and a
  pre-existing `data/smithers-hub.sqlite` is reused in place (no DB orphaned).

## What was renamed (product → RunYard)

### Package + bins + file rename (`git mv`, history preserved)
- `package.json` name `smithers-hub` → `runyard`.
- Bins: `runyard`, `runyard-mcp`, `runyard-runner` (old `smithers-hub` /
  `smithers-hub-mcp` / `smithers-hub-runner` bins removed).
- `src/smithers-runner.js` → `src/runner.js` (+ every import/spawn/ExecStart/CMD,
  `pnpm runner` script, bin wrapper, smoke script, Dockerfile.runner).
- `bin/smithers-hub*.js` → `bin/runyard*.js`.
- `deploy/smithers-hub.service` → `deploy/runyard.service`;
  `deploy/smithers-hub-runner.service` → `deploy/runyard-runner.service`.
- `tests/smithers-runner-source.test.js` → `tests/runner-source.test.js`.

### Env vars — `SMITHERS_HUB_*` → `RUNYARD_HUB_*` (back-compat preserved)
The new `RUNYARD_HUB_*` names are preferred everywhere; the legacy `SMITHERS_HUB_*`
names are still read as **fallback aliases** so existing deployments/tokens keep
working. Centralized via a `firstEnv("RUNYARD_HUB_X", "SMITHERS_HUB_X")` helper in
`src/env.js`; the same precedence is applied in `drain.js`, `mcp.js`, `runner.js`,
`cli.js`, `repoCatalog.js`, `runyardSupportAgent.js`, and the generated
`install.sh`. Renamed vars: `URL`, `TOKEN`, `DATA_DIR`, `DB`, `ARTIFACT_DIR`,
`ROOT`, `INSTANCE_NAME`, `SESSION_SECRET`, `BOOTSTRAP_TOKEN`, `ENVIRONMENT`/`ENV`,
`HOSTNAME`, `REMOTE`, `MOBILE_FEEDBACK_SECRET`, `SUPPORT_AGENT_*`.
`.env.example`, `docker-compose*.yml`, `Dockerfile.hub`, the dstack compose,
`install.sh`, `DEPLOY.md`, and the docs were updated to the new names (compose uses
nested `${RUNYARD_HUB_X:-${SMITHERS_HUB_X:-default}}` so legacy host vars still feed
the containers).

### Identity / user-facing strings
- `/api/version` name, MCP `serverInfo.name` (`runyard-mcp`), MCP origin label,
  llms.txt, OpenAPI title, install banner ("Installing RunYard client"), the
  CLI program name + every `runyard …` example, log banners, bootstrap-token line.
- Default repo key `smithers-hub` → `runyard` in `repoCatalog.js`, the seeded
  `runyard-mobile-feedback` endpoint, and `product-workflow`/`improve` defaults
  (resolver still accepts `smithers-hub` as a legacy alias).
- Artifact `generatedBy: "smithers-hub"` → `"runyard"`; knowledge seed slug
  `smithers-hub-mental-model` → `runyard-mental-model`.
- Local CLI config dir `~/.smithers-hub` → `~/.runyard`; client install dir
  `~/.smithers-hub/app` → `~/.runyard/app`.
- UI (`web/`), `public/landing.html`, `public/docs.html`, `public/styles.css`,
  `public/hub-hero.svg`, `README.md`, `SPEC.md`.
- Coupled tests updated to match new code (bins, MCP server name, install banner,
  default-repo value, endpoint repo) — not gamed greps, real expectations.

## What was deliberately KEPT as the Smithers engine
These are the upstream engine we depend on and shell out to — renaming them breaks
execution, so they are untouched:
- `smithers` CLI binary and all `smithers up/events/inspect/output/cancel` calls.
- `smithers-orchestrator` npm package / `bun add -g smithers-orchestrator`.
- `.smithers/` workspace dir; `SMITHERS_WORKSPACE` env var.
- `engine: "smithers"` capability fields; runner tag `smithers`; `run-smithers`
  capability slug + `run-smithers.tsx`; `src/resolveSmithersBin.js`,
  `src/smithersFailure.js`, `src/smithersHardening.js`, `src/runSmithersWatcher.js`.
- Non-`HUB` runner/engine env vars left in scope-respecting place:
  `SMITHERS_RUNNER_*`, `SMITHERS_RUN_*`, `SMITHERS_TRUST_PROXY`,
  `SMITHERS_OBSTRUCTION_*`, `SMITHERS_TELEGRAM_*`, `SMITHERS_DRAIN_DIR`,
  `SMITHERS_AUTH_HEALTH_TTL_MS` (the task scoped env renaming to `SMITHERS_HUB_*`).
- Artifact `generatedBy: "smithers-runner"` (runner producer tag; pinned by tests).

## Deliberate exceptions / notes
- **`src/env.js` keeps two `smithers-hub.sqlite` references** (a comment + the
  legacy-DB fallback in `defaultDbPath`). This is an intentional data-safety shim:
  if `RUNYARD_HUB_DB` is unset and only a legacy `data/smithers-hub.sqlite` exists,
  the hub keeps using it in place rather than silently starting a fresh empty DB.
  Passive (not a rename) because the DB runs in WAL mode. This is the same
  back-compat spirit the task mandates for the env-var aliases.
- **`workflow-templates/` and `specs/`** (engine capability internals, real
  runner filesystem paths like `~/smithers-hub`, and dated historical goal/spec
  records) were left as-is — not in the product gate dirs, and editing the path
  guesses/prod service names would risk breaking the live runner deployment. The
  resolver accepts `smithers-hub` as a legacy default-repo alias so they keep
  working.
- The `shub_` access-token prefix is unchanged (renaming it invalidates all
  existing tokens).

## Gate results
- `grep -rIn "smithers-hub" src web public bin package.json` → only the 2
  documented `src/env.js` legacy-DB lines (data-safety back-compat).
- `grep -rIn "SMITHERS_HUB_" src` → only as back-compat fallback aliases (always
  after a `RUNYARD_HUB_*` primary) and explanatory comments.
- Engine refs (`smithers up`, `smithers-orchestrator`, `.smithers/`,
  `SMITHERS_WORKSPACE`, `engine: "smithers"`, `run-smithers`) all present + intact.
