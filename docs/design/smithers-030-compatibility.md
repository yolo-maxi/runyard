# Smithers 0.22.0 → 0.30.0 compatibility matrix

Status: implementation reference for the `upgrade/smithers-v0.30` branch.
Evidence: every "probed" claim below was reproduced against an isolated
`smithers-orchestrator@0.30.0` install on this host (2026-07-23), including a
migration rehearsal against a `sqlite3 .backup` copy of the live 391 MB
production `smithers.db`. Nothing in this document was taken from release
prose alone; CLI/JSON shapes were captured from real invocations.

Verdict legend:
- **unaffected** — proven no RunYard change needed
- **migrate** — required change on this branch
- **integrate** — optional 0.30 capability adopted now (low-risk, material win)
- **defer** — captured as a Kanban-ready idea, not built now
- **reject** — considered and deliberately not adopted (rationale given)

## 1. Launch contract (`up … -d --format json`)

| Upstream change | Verdict | Detail |
|---|---|---|
| 0.30 pre-spawn fail-fast: invalid workflow → exit 1, JSON `{code:"DETACHED_PREFLIGHT_FAILED", message:"file:line:col …"}`, no run id | **migrate** | Probed. `parseSmithersRunId` previously threw a generic "no run id" error. The runner now surfaces the engine's structured preflight error so the Hub records *why* the launch failed. |
| Detached launch JSON gains `logFile`, `pid`, `monitoring`, `cta` | **unaffected** | Probed: additive; `JSON.parse(stdout).runId` path unchanged. Detached run ids remain `run-<ms>`; foreground ids are UUIDs (regex fallback only matters for detached). |
| `--started-by-harness/--started-by-session/--started-by-prompt` launch attribution (persisted, surfaced by `inspect`/`getRun`) | **integrate** | Probed: without explicit flags 0.30 *mis-detects* the harness (recorded `codex` for a runner-spawned run). The runner now stamps `--started-by-harness runyard-runner` + the Hub run id as session so engine-side provenance is truthful. |
| `--annotations` flat-JSON run annotations | **defer** | Idea: mirror Hub run id/capability into engine annotations for cross-tool debugging. Not load-bearing now. |
| `--parent-run-id` persisted lineage | **defer** | Idea: link retries/resumes into engine lineage. |
| `--post-failure` autopsy workflow **defaults ON** | **migrate** | Runner passes `--no-post-failure` (and sets `SMITHERS_POST_FAILURE=0`): RunYard owns failure handling; an engine-spawned autopsy run would consume credits outside Hub supervision. |
| `--report` result narration (interactive-only) | **unaffected** | Detached/non-TTY runs are not affected (probed: no report artifacts). |
| stdin input (`--input -`) | **unaffected** | Probed on 0.30 with the large-input path. |

## 2. Poll contracts (`inspect` / `events` / `output`)

| Upstream change | Verdict | Detail |
|---|---|---|
| `events` default is **lifecycle-only** since 0.28 (`DEFAULT_LIFECYCLE_EVENT_TYPES`); `TokenUsageReported`, `AgentEvent`, tool-call, scorer, timer events are filtered out | **migrate (critical)** | Probed against CLI source and a live run. Without `--raw`, RunYard's usage metering (`TokenUsageReported`) and failure detail events silently vanish. The runner now polls `events <sid> --json --raw --limit 100000` — exact 0.22 parity (0.22 had no filter). |
| Event NDJSON line shape `{runId, seq, timestampMs, type, payload}` | **unaffected** | Probed: identical to 0.22 consumption (`payload.type`, `payload.nodeId`, `payload.error` on `NodeFailed` still `{name,message,stack}`). |
| `inspect` canonical `nodes[].nodeId`; legacy `steps[].id` retained | **unaffected** | Probed: `steps[]` still present; RunYard reads `runState.state || run.status`, both intact. `startedBy`, `config`, `cta` are additive. |
| `inspect` `approvals[].status` is now `"requested"` (0.22: `"pending"`) | **migrate** | Probed. The engine-approval bridge's pending filter now accepts both. |
| Authored approval `request.{title,summary}` still absent from `inspect`; present on `ApprovalRequested`/`NodeWaitingApproval` **events** | **migrate** | Probed. The bridge captures request copy from the event stream (it already watches decision events) instead of expecting a 0.25+ inspect shape that never materialized. |
| `output <sid> <node> --json` strips provenance columns (0.29) | **unaffected** | Probed: clean payload (`{"value":14}`); RunYard never consumed the provenance columns. |
| `failedChildren`/`failedChildKeys` on finished runs (0.25.1) | **defer** | Idea: sharpen partial-failure display. RunYard already extracts failing nodes from events. |
| `listRuns --offset` pagination, malformed offset → `INVALID_REQUEST` | **unaffected** | RunYard does not call `ps`/`listRuns` on the runner path. |

## 3. Approvals / pause / resume / cancel

| Upstream change | Verdict | Detail |
|---|---|---|
| **Detached owner process exits at an approval gate** (since ~0.24; probed on 0.30). After `approve`, run parks at `waiting-event`; nothing resumes it without a supervisor | **migrate (critical)** | In 0.22 the detached owner stayed alive through gates, so applying `smithers approve` resumed work in-process. On 0.30 the bridge must relaunch `up <workflow> --resume <sid> --force -d` after a successful apply. Probed end-to-end: approve → `waiting-event` → resume → `finished/succeeded`, gated task output present. |
| `approve/deny --iteration` (defaults to pending gate's iteration), `--note`, `--by` | **integrate** | Probed. Closes the known 0.22 iteration>0 fail-closed gap; the bridge passes the gate's iteration explicitly and keeps sending provenance (`--by`, `--note`). |
| `smithers pause` (0.28, graceful: finish in-flight then park `paused`) | **reject for Hub pause** | Probed: `pause` → `pause-requested` → parks only after in-flight tasks finish. RunYard's pause must release the runner slot immediately; `cancel` + checkpoint-resume remains the correct primitive (probed: cancel → `cancelled` in ~5 s, owner processes gone; `up --resume <sid> --force` revives it). Captured as an idea for a future operator-facing "soft pause". |
| Claim-based cancellation (0.28): cascades to children/detached owners, finalizes pending approval gates | **unaffected** | Probed: cancel of a waiting-approval run and of a mid-task run both settle `cancelled`; resume-after-cancel still works with `--force`. |
| New non-terminal statuses: `waiting-event`, `waiting-timer`, `waiting-quota`, `pause-requested`, `paused` | **migrate (partial)** | Terminal set `{succeeded,failed,cancelled,errored}` still correct (probed `failed` via prod-copy runs, `cancelled`, `succeeded`). Unknown statuses were already treated as non-terminal. Integrated: `waiting-quota` now maps to a structured Hub pause (`quota_exhausted`) instead of relying on text-scraping alone; `waiting-event` with no pending approvals and a dead owner is handled by the bridge resume. |
| Foreground approval park exit code | **unaffected** | Probed: still exit 3 (`classifySmithersProcessExit` contract intact). |
| Supervisor / `supervise` auto-resume | **reject** | RunYard's Hub/runner own lifecycle; running a second resume authority would race the bridge and the pause store. Explicitly not enabled; the runner is the only resume path. |

## 4. Binary resolution, delegation, daemon, environment

| Upstream change | Verdict | Detail |
|---|---|---|
| **Project-local delegation** (0.27): the global binary re-execs the nearest `.smithers/node_modules` or project `node_modules` smithers, walking up from cwd; unconditional, no env escape | **migrate (operational)** | Probed: a 0.30 binary invoked with cwd inside the RunYard repo executed 0.22.0. The live runner workspace contains a `smithers init` pack pinning `^0.22.0` with its own `node_modules` — **the workspace pack, not the global binary, is the effective engine**. Runner startup now measures the *effective* version (`smithers --version` with cwd=workspace), logs it, reports it to the Hub, and warns on drift from the pinned version. The migration runbook upgrades the workspace pack explicitly. |
| Gateway singleton daemon (0.27) may autostart from CLI commands | **migrate (defensive)** | Probed: none of the commands RunYard uses (`up -d`, `inspect`, `events`, `output`, `cancel`, `approve`, `deny`, `init`, `graph`, `ps`) autostarted a daemon. The runner still sets `SMITHERS_NO_DAEMON=1` for every engine invocation ("fail loud instead of silently spawning" is upstream's own recommendation for containers). |
| Daily update check (`smithers update`, 0.27) | **migrate (defensive)** | Runner sets `SMITHERS_NO_UPDATE_CHECK=1`: deterministic runners must not see drift nudges or network pings. |
| 0.28 worktree reaping default (`SMITHERS_KEEP_WORKTREES` opt-out; dirty/unpushed preserved) | **unaffected** | RunYard templates never use `<Worktree>`; repo mutation happens in RunYard-managed clones/leases. Default reaping (with dirty/unpushed preservation) is safe and reduces disk pressure. |
| 0.29 detached log relocation → `<ws>/.smithers/logs/<runId>.log` + `SMITHERS_LOG_RETENTION_DAYS`/`SMITHERS_LOG_MAX_TOTAL_BYTES` | **unaffected (documented)** | Probed. RunYard never read the old side-by-side log path (it captures events/outputs itself). Retention defaults now bound a previously unbounded log pile — an operational win, noted in DEPLOY docs. |
| `SMITHERS_RUN_ID/NODE_ID/ITERATION/ATTEMPT` injected into spawned agents (0.23) | **unaffected** | Additive child-env context; RunYard's allowlist governs what *RunYard* forwards, engine-injected vars are internal to the engine's children. |
| `smithers init` (0.30): interactive by default; `--yes --non-interactive` supported; scaffolds pack with own `package.json` (`^0.30.0`) + `node_modules`; **rewrites `agents.ts` on every run**; installs skills into detected agent homes | **migrate** | Probed (sandboxed `$HOME`). `cliRunnerSetup` now passes `--yes --non-interactive`, verifies the effective engine version after init, and the runbook warns that re-init clobbers a customized `agents.ts` (verified by checksum). |

## 5. Workspace state / schema migration

| Aspect | Verdict | Detail |
|---|---|---|
| Schema advances 0014 → 0030 (`output_provenance`) | **migrate (runbook)** | Probed on a backup copy of the production db (391 MB, 764 runs): reads (`ps`, `inspect`, `events`) work **without** migrating; the first write (`up`) auto-migrates, ~2.4 s, no prompts, no data loss (pre-upgrade runs remain inspectable). |
| Rollback | **runbook** | Probed: 0.22 can still read **and write** a 0.30-migrated store (additive migrations; `_smithers_schema_migrations` is tolerated). Still, the runbook requires a `sqlite3 .backup` before cutover; restore is the guaranteed path. |
| Backend receipts / Postgres / PGlite (0.23–0.26) | **reject** | RunYard stays on SQLite (`smithers.db` at workspace root — unchanged in 0.30). No `migrated.json` exists in the live workspace; nothing to do. |
| Checkpoint/resume across upgrade | **runbook** | Cancel-parked 0.22 checkpoints are resumed by 0.30 via the same `up --resume <sid> --force` (probed on 0.30-created state; prod rehearsal step included in the runbook — resume one paused run as a canary before declaring cutover done). |

## 6. Templates and package symbols

| Aspect | Verdict | Detail |
|---|---|---|
| `createSmithers`, `Sequence`, `Parallel`, `ClaudeCodeAgent`, `CodexAgent`, `PiAgent`, JSX runtime | **unaffected** | All 28 workspace workflows (21 RunYard templates + 7 pack workflows) pass `smithers graph` on 0.30; env-conditional ones (improve family needs a git-repo target, workflow-doctor needs `WORKFLOW_DOCTOR_REPO_DIR`) validate once their inputs exist — same as 0.22. |
| Zod input defaults now apply in `ctx.input` (0.28) | **unaffected** | RunYard always passes explicit input; templates with `.default(...)` now actually receive defaults — strictly better, no template relied on null-arrival. |
| Reserved output field names rejected (0.25, e.g. `runId` in an output schema) | **unaffected** | Grep + graph validation: no template uses reserved names (existing `smithersHardening` lint already guards new bundles). |
| `providers` from pack `agents.ts` (hello / research / reauth-cli) | **runbook** | 0.30 init regenerates `agents.ts` with providers enabled only for agents that pass an availability probe. Live workspace keeps its customized `agents.ts` as long as init is not re-run. |

## 7. New 0.30 surface — considered, not integrated (opportunity backlog)

Monitor / "Needs you" triage view, `gateway-ui` fleet & chat widgets, agentic
UI kit, `oneshot`, workflow packs (`add`/`packs update`/`eject`/`share`),
`update`/`upgrade`, memory + XState folds, cron/alerts/human task queue,
hijack, time travel (`fork`/`replay`/`rewind`/`timeline`), browser viewer,
sandbox providers (Microsandbox/AWS/GCP/Daytona/Vercel), `status`/`what`/`why`
diagnostics, Electric multiplayer, `eval`/`optimize`.

Each is evaluated with rationale and acceptance shape in
`docs/design/smithers-030-opportunities.md`. None is load-bearing for the
engine replacement, and several (Monitor, supervise, packs) would create a
second control-plane authority competing with the Hub — the same product-shape
call RunYard has already made deliberately (hub-as-supervisor retirement,
custom board UI).

## 8. Dependency / security posture

- Isolated install resolves ~1,079 packages (0.22: ~540). Deprecated
  transitive warnings: `@daytonaio/sdk@0.194.0`, `glob@10.5.0`,
  `node-domexception@1.0.0`, `uuid@9.0.1` — all pulled by optional
  sandbox/cloud providers RunYard never invokes on the runner path.
- `pnpm audit --prod` triage lives in the readiness report
  (`docs/design/smithers-030-readiness.md`) with reachability notes per
  finding; see that file for the gate result.
- Engines: `node >=22`, `bun >=1.3.0` — satisfied (host: Node 24.18.0,
  Bun 1.3.14; image: node 22 + bun 1.3.14 pinned).
