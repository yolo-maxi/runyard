# Smithers 0.30 replacement-readiness report

Branch: `upgrade/smithers-v0.30` (base: v0.11.17 / `073e44f`).
Companions: `docs/design/smithers-030-compatibility.md` (full change matrix,
verdicts, probe evidence), `docs/smithers-030-migration-runbook.md` (live
cutover + rollback), `docs/design/smithers-030-opportunities.md` (Ideas-lane
backlog).

## What changed on this branch

**Pins (all 0.30.0, guarded by `tests/smithers-version-pins.test.js`):**
`package.json` dependency, `pnpm-lock.yaml`, `install.sh` default,
`Dockerfile.runner` ARG, `DEPLOY.md`. The pin test additionally asserts the
runner-facing `pinnedSmithersVersion` export equals the canonical pin.
`express` moved `^4.19.2 → ^4.22.2` in passing (in-range, audit hygiene).

**Runner/engine contract (`src/runnerSmithersRuntime.js`, `src/runner.js`):**
- `events` polling adds `--raw` — on ≥0.28 the default view filters to
  lifecycle types and silently drops `TokenUsageReported`; without this,
  usage metering and budgets die with no error anywhere. `--raw` is exact
  0.22 parity (0.22 had no filter).
- Every engine invocation pins `SMITHERS_NO_DAEMON=1`,
  `SMITHERS_NO_UPDATE_CHECK=1`, `SMITHERS_POST_FAILURE=0`
  (`ENGINE_BEHAVIOR_ENV`); launches additionally pass `--no-post-failure`.
  No gateway daemon, no update pings, no engine-spawned autopsy runs.
- Launches stamp persisted attribution: `--started-by-harness runyard-runner
  --started-by-session <hub run id>` (without it, 0.30 mis-detects and
  records the wrong harness — observed `codex`).
- 0.30 fail-fast launches (`DETACHED_PREFLIGHT_FAILED`, exit non-zero, no run
  id) surface the engine's `file:line:col` diagnostic as a
  `runner.launch_failed` event and a `blocked_by_preflight` failure.
- Engine `waiting-quota` parks map to a structured Hub pause
  (`quota_exhausted`) carrying the checkpoint; error-text classification
  remains as fallback.
- Runner startup measures the EFFECTIVE engine version (cwd=workspace, where
  project-local delegation decides), logs it, appends it to the runner's
  platform string (visible in the existing runners table/API), and warns
  with remediation on drift.

**Approval bridge (`src/runnerEngineApprovals.js`):**
- Accepts 0.30's `approvals[].status: "requested"` (0.22: `"pending"`).
- Quotes the authored `<Approval request>` from
  `ApprovalRequested`/`NodeWaitingApproval` events on the Hub card (inspect
  never exposes it on either version).
- After a decision (Hub-applied or engine-side), relaunches the parked run
  from its checkpoint: on ≥0.24/0.30 the detached owner EXITS at a gate and
  the run parks `waiting-event` forever without this. Fires once per decided
  round, retries on failure, never fires for non-approval waits.

**Setup (`src/cliRunnerSetup.js`):** `smithers init --yes --non-interactive`
(0.27+ init is interactive), warns before init clobbers an existing
customized `agents.ts` (verified it does), reports the effective engine
version after setup.

**Docs:** DEPLOY.md delegation/effective-version note + 0.29 log-relocation
note; runs.mdx structured quota-pause wording; the three companion documents.

## Evidence (all real 0.30, no mocks; isolated workspaces)

- Foreground + detached compute workflow: succeeded; detached JSON additive
  (`logFile` in `.smithers/logs/`, `pid`, `monitoring`, `cta`).
- Invalid workflow detached: exit 1, `DETACHED_PREFLIGHT_FAILED` +
  `file:line:col`, no run created.
- Inline and stdin (`--input -`) input paths.
- `inspect`/`events --raw`/`output` shapes verified compatible; approval
  status rename caught and covered.
- Cancel of a live run → `cancelled` in ~5 s, owner processes gone; resume
  of the cancelled run with `--force` → running → terminal.
- Full approval loop: gate → owner exit (verified) → `approve --by --note`
  → `waiting-event` (verified stuck without resume) → resume → succeeded,
  gated output present; `--iteration` now defaults to the pending gate
  upstream (closes the known 0.22 iteration>0 gap).
- `pause` verb probed: graceful only (parks after in-flight work) — rejected
  for Hub pause, kept as a backlog idea.
- Foreground approval park still exits 3 (`classifySmithersProcessExit`
  contract intact).
- Failing task: `NodeFailed` payload.error keeps `{name,message,stack}`;
  engine retries with backoff before terminal failure.
- Migration rehearsal on a `sqlite3 .backup` copy of the production db
  (391 MB, 764 runs, schema head 0014): reads don't migrate; first write
  migrates to 0030 in ~2.4 s; old runs stay inspectable; **0.22 still reads
  and writes the migrated store** (rollback safe even without restore).
- All 28 workspace workflows (21 RunYard templates) pass `smithers graph` on
  0.30; the 5 env-conditional ones validate with a git-repo target /
  `WORKFLOW_DOCTOR_REPO_DIR` set.
- No gateway daemon observed from any runner-used command (and
  `SMITHERS_NO_DAEMON=1` is pinned anyway); no orphaned processes after the
  probe suite.
- Runner image built on this host with `SMITHERS_VERSION=0.30.0`: container
  smoke shows `smithers --version` = 0.30.0 via `SMITHERS_BIN`, PATH, and
  `resolveSmithersBin()`, and a real workflow ran to `finished` inside the
  container (node 22.23.1, bun 1.3.14).

## Gates

| Gate | Result |
|---|---|
| `git diff --check` | clean |
| Pin-coherence tests | pass (6/6, incl. new pinnedSmithersVersion assertion) |
| `pnpm install` / lockfile | clean (peer warnings noted below) |
| Full `pnpm test` | 1573 pass / 0 fail / 2 skip (pre-existing skips) |
| `pnpm build` | pass |
| `pnpm build:docs` | pass |
| Runner image build + container smoke | pass (see evidence) |
| CLI help smoke | pass (no CLI surface changed) |
| Web UI browser smoke | n/a — no web code changed (engine version rides the existing platform string) |

## Dependency & security triage

- Graph grows ~540 → ~1,079 packages (sandbox/cloud providers, UI kit,
  Effect). Peer warnings: react-reconciler-style pins inside upstream UI
  packages; not consumed by RunYard code paths.
- Deprecated transitives: `@daytonaio/sdk@0.194.0`, `glob@10.5.0`,
  `node-domexception@1.0.0`, `uuid@9.0.1` — all inside optional provider
  chains RunYard never invokes.
- `pnpm audit --prod`: 17 findings (7 high / 9 moderate / 1 low). Every
  high/moderate is transitive under `@smithers-orchestrator/daytona` (6×
  protobufjs, otel×2), `/gcp` (uuid), or `/agents`' MCP chain (fast-uri,
  hono Windows-only path traversal). Reachability: the Daytona/GCP sandbox
  providers are never instantiated by RunYard's runner (local/bubblewrap
  execution only), and the runner host is Linux. These libraries load only
  if a workflow explicitly opts into those providers — treated as dormant;
  revisit if a sandbox-provider idea from the backlog is picked up.
- The one finding in RunYard's own tree: `body-parser` <1.20.6 (low, DoS via
  *invalid* limit config) via express 4.22.2. RunYard passes explicit valid
  limits (`src/httpMiddleware.js`), so the condition is unreachable;
  accepted rather than force-overridden.
- Build scripts: pnpm's secure default left 6 packages' scripts unrun
  (`@smithers-orchestrator/jj-linux-x64`, protobufjs, koffi,
  msgpackr-extract, @parcel/watcher, esbuild). Intentionally kept: the Hub
  app tree never executes workflows (the runner uses the bun-installed
  engine, whose own install runs its scripts — jj works in the image), and
  esbuild's binary comes via its install fallback. No `onlyBuiltDependencies`
  added.

## Residual risks (honest list)

1. **Approval resume relaunch is unit-tested + engine-probed, not yet proven
   through a full Hub round-trip** — the runbook's canary gate 4 is the
   final proof (gated workflow, approve from Hub card, terminal).
2. **`--raw` event volume**: same data 0.22 returned, but long agent runs
   re-read full history each poll (pre-existing O(n²) behavior; backlog idea
   #1 fixes it properly). 32 MB maxBuffer bound unchanged.
3. **Live workspace pack upgrade is manual** (runbook §3). The runner warns
   on drift but will still launch with a drifted engine (deliberate: an
   operator mid-upgrade must not lose the runner). The drift marker is
   visible in the Hub runners table.
4. **Zod input defaults now apply** (0.28): templates were swept and RunYard
   always passes explicit input, but third-party/authored workflows relying
   on null-arrival semantics would change behavior.
5. **`waiting-quota` pause path is code-reviewed + status-probed, not
   provider-reproduced** (needs a real quota exhaustion to fire end-to-end);
   the text-classifier fallback still covers the failure-shaped variant.

## Ocean's remaining cutover checklist

1. Review branch diff; merge/deploy the RunYard application per normal
   release process (pin test forces coherence).
2. Execute `docs/smithers-030-migration-runbook.md` §0–§6 on the live
   host(s): drain → backup → workspace pack upgrade → global binary → 
   template re-sync → restart → canary gates 1–5.
3. Insert/dedupe `docs/design/smithers-030-opportunities.md` into the Work
   board Ideas lane.
4. Roll the second runner only after the first passes all canaries.
