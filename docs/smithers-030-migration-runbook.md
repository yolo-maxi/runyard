# Smithers 0.22.0 → 0.30.0 migration & rollback runbook

Audience: the operator performing the live RunYard cutover (Ocean). Every step
is executable as written; nothing requires re-deriving the investigation. The
branch `upgrade/smithers-v0.30` must already be reviewed and merged/deployed as
the RunYard application version before the engine cutover below.

**The one fact that shapes this whole runbook:** since 0.27 the `smithers`
binary delegates to the nearest project-local install, walking up from its
cwd, and a workspace pack (`.smithers/node_modules`) wins over everything.
The live runner workspace (`/home/xiko/smithers-workspace/.smithers`) is a
`smithers init` pack pinning `smithers-orchestrator@^0.22.0` with its own
`node_modules` — **that pack, not the global bun binary, is the engine that
executes runs**. Upgrading only the global binary changes nothing; upgrading
only the pack leaves the global binary lying about its version. Both move
together.

## 0. Preflight (no changes yet)

```bash
# Runtime floors (need node >=22, bun >=1.3.0)
node --version && bun --version

# What each layer currently resolves — record all three numbers
smithers --version                                        # global (delegates from $PWD!)
cd /home/xiko/smithers-workspace && smithers --version    # EFFECTIVE engine for runs
grep smithers-orchestrator /home/xiko/smithers-workspace/.smithers/package.json

# No runs in flight (or wait / drain first — see §1)
runyard runs --status running,assigned,queued
```

Do not proceed while runs are executing; pause or let them finish.

## 1. Drain the runner

```bash
# Drain flag under the shared Hub dataDir (src/drain.js precedence:
# SMITHERS_DRAIN_DIR > RUNYARD_HUB_DATA_DIR > <hub root>/data). On the
# standard single-box install that is <repo>/data:
touch /home/xiko/runyard/data/.drain
# runner stops claiming, finishes in-flight work; wait until:
runyard runners   # active runs 0
```

Paused and queued runs are safe: paused runs are never reaped, queued runs
just wait for the runner to return.

## 2. Back up engine state (the guaranteed rollback)

```bash
cd /home/xiko/smithers-workspace
sqlite3 smithers.db ".backup 'smithers.db.pre-030-$(date +%s)'"
cp -a .smithers/package.json .smithers/package.json.pre-030
cp -a .smithers/agents.ts   .smithers/agents.ts.pre-030      # init would clobber it
cp -a .smithers/bun.lock    .smithers/bun.lock.pre-030 2>/dev/null || true
```

Verified behavior (rehearsed against a backup copy of this exact production
db, 391 MB / 764 runs): 0.30 reads the 0.22 store without migrating; the
first **write** auto-migrates schema 0014 → 0030 in ~2.4 s with no prompts,
and pre-upgrade runs stay inspectable. 0.22 was verified to still read AND
write a 0.30-migrated store (additive migrations), so even after migration a
binary rollback works — but the `.backup` file above is the guaranteed path.

## 3. Upgrade the workspace pack (the effective engine)

**Do NOT run `smithers init` on the live workspace** — it rewrites
`.smithers/agents.ts` (verified by checksum) and would discard the customized
providers. Edit the pack in place:

```bash
cd /home/xiko/smithers-workspace/.smithers
# package.json: "smithers-orchestrator": "^0.22.0" -> "0.30.0" (pin exact)
sed -i 's/"smithers-orchestrator": "[^"]*"/"smithers-orchestrator": "0.30.0"/' package.json
bun install
cd /home/xiko/smithers-workspace && smithers --version   # MUST print 0.30.0
```

## 4. Upgrade the global binary (keeps non-workspace invocations honest)

```bash
bun add -g smithers-orchestrator@0.30.0
smithers --version   # from a neutral cwd: 0.30.0
```

For containerized runners instead: build/pull the 0.30 runner image
(`Dockerfile.runner` already pins `SMITHERS_VERSION=0.30.0`) and roll it out;
`install.sh` defaults to 0.30.0 for bare-host installs.

## 5. Re-sync workspace templates

The runner executes WORKSPACE copies of the templates, not the repo's.

```bash
cp /home/xiko/runyard/workflow-templates/workflows/* \
   /home/xiko/smithers-workspace/.smithers/workflows/
```

(No template changed for 0.30 compatibility — all 21 graph-validate as-is —
but the branch may carry unrelated template updates; keep them in sync.)

## 6. Restart the runner and verify the canary gates

```bash
rm /home/xiko/runyard/data/.drain    # undrain
# restart runner service(s) per DEPLOY.md
```

Startup log MUST show:

```
[engine] effective smithers 0.30.0 (pinned 0.30.0) in /home/xiko/smithers-workspace
```

If it shows `VERSION DRIFT` instead, stop and fix §3/§4 — the log names the
exact remediation. The Hub runners table also shows the effective engine in
the runner's platform string (`… · smithers 0.30.0`); a drifted runner shows
`(DRIFT: expected …)` there.

Canary sequence (in order, each gate must pass before the next):

1. **hello run** — `runyard run hello` (or the web board): reaches
   `succeeded`, artifacts present, `TokenUsageReported` usage rows appear on
   the run (proves the `--raw` events path).
2. **pause/resume** — pause a fresh hello run mid-flight, confirm `paused`
   with checkpoint, resume, confirm terminal success (proves cancel-based
   checkpointing against 0.30 state).
3. **resume a PRE-UPGRADE paused run** (if any exists): proves cross-version
   checkpoint resume on the migrated store. Expect the first write to
   migrate the db (fast); watch the runner log once.
4. **approval flow** — run a gated workflow (`implement-change-gated`),
   approve from the Hub card, confirm the run continues to terminal. On 0.30
   the engine parks `waiting-event` after the decision and the runner
   relaunches it from the checkpoint automatically (`engine.approval.resumed`
   event with `resumeLaunch: true`).
5. **no daemon** — `pgrep -af "smithers.*gateway"` on the runner host: no
   workspace gateway daemon may exist (runner pins `SMITHERS_NO_DAEMON=1`).

## 7. Rollback (if any canary gate fails)

```bash
# 1. Drain again; stop the runner.
# 2. Restore the pack:
cd /home/xiko/smithers-workspace/.smithers
mv package.json.pre-030 package.json && mv agents.ts.pre-030 agents.ts
[ -f bun.lock.pre-030 ] && mv bun.lock.pre-030 bun.lock
bun install
# 3. Global binary back:
bun add -g smithers-orchestrator@0.22.0
# 4. Only if the db misbehaves under 0.22 (not expected — verified additive):
cd /home/xiko/smithers-workspace && mv smithers.db.pre-030-<ts> smithers.db
# 5. Redeploy the previous RunYard application version (its pin test expects 0.22.0).
# 6. Restart, verify: cd /home/xiko/smithers-workspace && smithers --version -> 0.22.0
```

Runs launched under 0.30 and rolled back mid-flight: their checkpoints remain
in the store; resume them from scratch if 0.22 refuses the resume.

## 8. Post-cutover

- Delete the drain flag if still present; confirm both runners heartbeat.
- Watch the first day of scheduled/factory runs for `runner.launch_failed`
  events (new fail-fast surface) and `runner.pause_detected` with
  `engineState: waiting-quota` (new structured quota pause).
- Keep `smithers.db.pre-030-*` for at least a week before deleting.

## Behavior changes an operator will notice after cutover

| Change | Where it shows |
|---|---|
| Detached logs move to `<ws>/.smithers/logs/<runId>.log`, auto-cleaned by retention (`SMITHERS_LOG_RETENTION_DAYS`, `SMITHERS_LOG_MAX_TOTAL_BYTES`) | runner host disk; old side-by-side `.log` files stop appearing |
| Invalid workflow launches fail instantly with `file:line:col` | run fails as `blocked_by_preflight` with `runner.launch_failed` event, instead of "no run id" |
| Engine quota parks become structured pauses (`quota_exhausted`) | attention queue / paused runs, instead of relying on error-text matching |
| Engine approval gates: run relaunches after decision | extra `engine.approval.resumed` (`resumeLaunch: true`) event in the timeline |
| Run provenance: engine records `startedBy: runyard-runner` + Hub run id | `smithers inspect` on the runner box |
| Completed-run engine worktrees are reaped by default (dirty/unpushed preserved) | less disk creep under the workspace |
