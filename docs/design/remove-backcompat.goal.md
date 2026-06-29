# GOAL: Remove ALL smithers-hub → runyard backward-compat shims (code + env + tests)

Working dir: `/home/xiko/runyard` (single box, Hetzner). The product was renamed
`smithers-hub` → `runyard`, but back-compat shims were left so legacy names kept working.
Fran wants **all backward compatibility removed** now. RunYard is the only name going forward.

## CRITICAL SCOPE BOUNDARY — do NOT touch these (they are NOT back-compat):
- The **upstream Smithers engine** we shell out to: `smithers` CLI, `smithers up/events/...`,
  `smithers-orchestrator` pkg, `.smithers/` workspace, `SMITHERS_WORKSPACE`, `engine:"smithers"`,
  runner tag `smithers`, `run-smithers` slug + `run-smithers.tsx`, `src/resolveSmithersBin.js`,
  `src/smithersFailure.js`, `src/smithersHardening.js`, `src/runSmithersWatcher.js`, and the
  non-HUB env vars `SMITHERS_RUNNER_*`, `SMITHERS_RUN_*`, `SMITHERS_TRUST_PROXY`,
  `SMITHERS_OBSTRUCTION_*`, `SMITHERS_TELEGRAM_*`, `SMITHERS_DRAIN_DIR`,
  `SMITHERS_AUTH_HEALTH_TTL_MS`. Renaming any of these BREAKS execution. Leave them exactly.
- The **`shub_` token prefix** (`src/security.js`, `shub_session` cookie, Bearer `shub_`).
  Renaming it invalidates every live access token. OUT OF SCOPE — do not touch. Leave `shub_`.
- `generatedBy: "smithers-runner"` artifact producer tag (pinned by tests) — leave.

## What to REMOVE (the actual back-compat shims):
1. **Env var fallbacks.** In `src/env.js` the `firstEnv("RUNYARD_HUB_X","SMITHERS_HUB_X")`
   calls must drop the legacy `SMITHERS_HUB_*` second args and read ONLY `RUNYARD_HUB_*`.
   Same for the equivalent precedence in `drain.js`, `mcp.js`, `runner.js`, `cli.js`,
   `repoCatalog.js`, `runyardSupportAgent.js`, and the generated `install.sh`. If `firstEnv`
   becomes a single-arg passthrough, simplify it (or replace with `process.env.RUNYARD_HUB_X`).
   Remove the now-stale explanatory comments about legacy aliases.
2. **MIGRATE the live env FILES in lockstep** (or the services break on restart). The live
   `.env`, `runner.env`, `support-runner.env` currently use `SMITHERS_HUB_URL`,
   `SMITHERS_HUB_TOKEN`, etc. Rewrite those keys to the `RUNYARD_HUB_*` equivalents, preserving
   the VALUES exactly (same URL, same token strings). Back up each file first
   (`cp x x.bak.backcompat`). DO NOT restart any service — just rewrite the files.
3. **Legacy DB fallback.** Remove the `defaultDbPath` legacy `data/smithers-hub.sqlite` reuse in
   `src/env.js`. New canonical DB path = `data/runyard.sqlite`. Do NOT rename the live DB file
   yourself — instead WRITE a cutover script `scripts/backcompat-db-cutover.sh` that: stops the
   hub, `git mv`/`mv` `data/smithers-hub.sqlite` (+ `-wal`/`-shm` if present) → `data/runyard.sqlite`,
   and restarts. (Operator runs it later; see "DO NOT do the live cutover" below.)
4. **Legacy repo-resolver alias.** Remove `smithers-hub` as a default-repo alias in
   `repoCatalog.js`. Then FIX every dependent that relied on the alias (specs/, workflow-templates/,
   seeds) to use `runyard` directly so nothing breaks. Grep to prove no live resolution still
   needs `smithers-hub`.
5. **CLI-dir reuse.** Remove any `~/.smithers-hub` reuse/fallback logic (the dir is already gone;
   canonical is `~/.runyard`).
5b. **Drop stale `GATED_PROD_DIR`.** `runner.env` has `GATED_PROD_DIR=/home/fran/smithers-hub`
   (a dead repo.box path). Remove that line entirely — do NOT repoint it. Gated deploys default
   to `deploy=false`; CVM deployment topology is the operator's concern, not this repo's.
6. **Systemd unit rename (prepare, don't apply).** WRITE a cutover script
   `scripts/backcompat-systemd-cutover.sh` that renames the live units
   `smithers-runner.service` → `runyard-runner.service` and
   `smithers-support-runner.service` → `runyard-support-runner.service`
   (disable old, install `deploy/runyard-runner.service` equivalents pointing at the SAME
   EnvironmentFile + ExecStart, enable + start new, confirm online). Ensure the deploy/ unit
   files exist and are correct. Do NOT run it.

## DO NOT do the live cutover in this run
There is an ACTIVE proof run (`runyard-phase2-claude`) leaning on the production hub + runners.
A DB rename or service restart would disrupt it. So: make ALL the code + env-file edits, write
the two cutover scripts, run the full test suite — but do NOT stop/restart the hub or runners,
do NOT rename the live DB, do NOT run the cutover scripts. The operator (Ocean main session) runs
those after the proof completes.

## Gates (must pass before DONE):
- `grep -rIn "smithers-hub\|SMITHERS_HUB_" src web public bin package.json` → ZERO hits except
  ones you can justify in writing (there should be none left in code after this).
- `grep -rIn "smithers-hub" .env runner.env support-runner.env` → zero (env files migrated).
- Engine refs intact: `grep -rIn "smithers up\|smithers-orchestrator\|\.smithers/\|SMITHERS_WORKSPACE\|engine: \"smithers\"\|run-smithers\|shub_"` still present and untouched.
- Full suite green: `node --experimental-sqlite --test tests/*.test.js` — fix any test that
  asserted the old back-compat behavior to assert the NEW strict behavior (real expectations,
  not gamed greps). Report pass count.
- Confirm the two cutover scripts exist, are executable, and are SAFE (backup before mv, idempotent).

## Deliverable
- A markdown report `/home/xiko/clawd/logs/runyard-backcompat-removal.md`: exact list of files
  changed, env-file key migrations (key names only, NOT token values), the two cutover scripts'
  contents, grep proof, test results, and a clear "operator next steps" section (run the two
  cutover scripts after the proof run; note the brief hub+runner downtime).
- Commit the code changes locally (do NOT push). Leave env-file + DB cutover as operator steps.

Keep going until gates pass or you hit a real documented blocker. Don't fake a pass.
