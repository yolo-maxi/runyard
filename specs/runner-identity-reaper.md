# Spec: Stable runner identity + offline reaper + UI hide-offline

Owner: Fran. Build on Hetzner (`/home/xiko/smithers-hub`), branch `feat/runner-reaper`. Commit only — NO push/deploy (Ocean reviews + deploys).

## Problem (root-caused)
The runners table accumulated 95 rows, nearly all stale but listed as runners (manually cleaned to 2 on 2026-06-24). Causes:
1. **Registration mints a new row every restart.** `registerRunner` (`src/db.js:1627`) only reuses an existing row when the client passes `input.id` AND its token owns it. The runner client (`src/smithers-runner.js`) does **not** persist/send a stable id across restarts, so `existing` is always null → `id("runner")` → a fresh ghost row each restart.
2. **No runner reaper / pruning.** Heartbeat-derived liveness already exists (`src/db.js:1675-1689`: `isRunnerLive` via `env.runnerOfflineMs`, list maps a computed `online`/status) — so dead rows *show* offline — but nothing ever deletes long-dead rows, and the UI lists every row regardless.

## Fix (3 parts)

### 1. Idempotent registration (stop the ghosts at the source)
In `registerRunner`, when no owned row is found via `input.id`, before inserting, look up an existing row by stable identity = (`token_id` + `name` + `hostname`) and reuse/UPDATE it if found. Only INSERT when there is genuinely no matching row. Keep the existing security property: never reuse a row whose `token_id` differs from the caller's. This means a normal service restart (same token, same name, same host) updates one stable row instead of spawning a new one.
- Also persist the assigned runner id on the client: `src/smithers-runner.js` should cache the id returned by `/runners/register` to a file under the workspace (e.g. `<workspace>/.smithers/runner-id`) and send it as `input.id` on subsequent registers. Server-side identity match is the primary defense; the id file is the fast path. Tolerate a missing/corrupt file.

### 2. Offline reaper / pruner
Add a runner pruner that runs on the existing reaper interval in `src/server.js` (same place `reapStuckRunIds` is invoked). Two tiers:
- Runners stale beyond `env.runnerOfflineMs` already compute as offline (no change needed for display).
- **Delete** runner rows whose `last_heartbeat_at` is older than a new `env.runnerPruneMs` (default e.g. 24h; configurable via env). Never delete a runner with `active_runs > 0` or a non-null `current_run_id`. Add `export function pruneDeadRunners(maxMs)` to `src/db.js` returning the count/ids pruned; call it from the server reaper loop and log when >0.
- Use proper datetime comparison (`datetime(last_heartbeat_at) < datetime('now', ...)`), NOT raw string compare — ISO-with-`T`/`Z` vs space-format strings miscompare (this exact bug bit the manual cleanup).

### 3. UI: hide offline runners by default
In `public/app.js` runners view + the Secrets-page auth-health strip: show **online** runners by default; collapse offline ones behind a "Show N offline" toggle (or a muted collapsed section). The `online` boolean is already on each runner from the API. Don't show auth-health rows for offline runners by default. Keep the existing offline-count badge working.

## Eval gates (all must pass)
- `pnpm test` fully green. Add tests:
  - register twice with same token+name+hostname and no id → **exactly 1 row** (idempotent); a different token+name → separate row.
  - `pruneDeadRunners`: a row with stale heartbeat is deleted; a stale row with `active_runs>0`/`current_run_id` is **kept**; a fresh row is kept.
  - datetime comparison correctness with ISO `...Z` timestamps (regression guard for the string-compare bug).
  - client id-cache: register returns id, client persists + resends it (unit-level with injectable fs/http if practical; otherwise test the server identity-match path).
- `git diff --check` clean; `node --check` on changed JS.
- Confirm no behavior change to live claim/matching (untagged runs still match; tags preserved).

## Do NOT
- No push, no deploy, no merge to main. Commit to `feat/runner-reaper` and stop.
- Don't change runner tag semantics or the claim matcher.
- Don't delete runners with in-flight work.

## Deliverable
Branch `feat/runner-reaper`, all gates green, SUMMARY at the end: files changed, test count, the prune-safety proof (active-runs guard + datetime fix), and exact manual deploy steps for Ocean (push origin+prod, restart Hub user service on repo.box, restart Hetzner runner services).
