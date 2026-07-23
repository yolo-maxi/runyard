# RunYard CI Platform — design record

Status: implemented on `feature/ci-platform-fable` (first production-shaped CI slice).

GitHub stays the canonical repository, PR, tag, release, and package surface.
RunYard is the external CI control plane: it receives verified GitHub events,
compiles a trusted `.runyard/ci.yml` into canonical RunYard runs, executes jobs
on existing RunYard runners, and reports GitHub Checks. No Git hosting, no
GitHub Actions clone, no second scheduler/artifact store/approval system.

The loop:

```
GitHub event -> signed + deduplicated delivery -> immutable trigger record
  -> CI pipeline (parent run) -> DAG of job runs on RunYard runners
  -> logs/artifacts/evidence -> GitHub Check updates -> merge decision on GitHub
```

## Layering

1. **SCM edge** (`src/githubApp.js`, `src/githubWebhooks.js`): GitHub App
   primitives implemented on native `node:crypto` + `fetch` (RS256 app JWT,
   just-in-time installation tokens, Checks REST calls with retry/backoff).
   Webhook ingress verifies `x-hub-signature-256` over the raw body before
   anything is parsed or trusted.
2. **CI domain** (`src/scm*.js`, `src/ci*.js`): provider-neutral records for
   installations, repositories, webhook deliveries, pipelines, and jobs. Jobs
   and pipelines link to canonical `runs` rows — live status is never
   duplicated into CI tables; only pre-dispatch phases (`pending`, `skipped`,
   `cancelled`) and reporter bookkeeping live there.
3. **Runner** (`src/runnerCi.js`): a deterministic CI executor branch in the
   existing runner (same claim/heartbeat/stall/cancel machinery). No LLM in
   the CI path.
4. **Execution adapters**: `native` (trust-gated host commands) and `dagger`
   (optional, probed; clear `infra_unavailable` when absent).
5. **Reporter** (`src/ciReporter.js`): GitHub Check Runs with idempotent
   updates, bounded annotations, retry/backoff, and a delivery ledger modeled
   on `run_response_endpoints`.

## Durable model (new tables)

- `scm_installations` — GitHub App installation identity (provider,
  installation id, account login/type, status). Never stores tokens.
- `scm_repos` — repository identity: provider, external id, owner/name,
  clone URL, default branch, installation ref, `enabled`, `trust_policy`
  JSON (`level: trusted|untrusted`, `allowNative`, `runnerTags`).
- `scm_webhook_deliveries` — receipt/idempotency ledger keyed by provider +
  delivery id with payload hash conflict detection; bounded retention (pruned
  by the CI sweep after `RUNYARD_CI_DELIVERY_RETENTION_MS`, default 14 days).
- `ci_pipelines` — one row per trigger: repo ref, parent `run_id`, immutable
  `trigger` JSON (event, action, delivery id, ref, head/base SHA, PR number,
  sender, receipt time), `config_source` JSON (trusted ref + SHA + path),
  `tested` JSON (strategy + pinned SHAs), `commit_sha` (the SHA that receives
  checks), `concurrency_key`, `superseded_by`.
- `ci_jobs` — one row per configured job: `job_name`, `needs`, `executor`,
  validated `spec` JSON, `required`, `phase`
  (`pending|dispatched|skipped|cancelled` — once dispatched, the linked run's
  status is the single source of truth), plus reporter bookkeeping
  (`check_run_id`, `check_state`, `check_attempts`, `last_check_error`).

Two internal capabilities are seeded: `ci-pipeline` (parent; requires the
`runyard-hub` tag no runner advertises, and is transitioned `queued->running`
by the hub immediately, so runners can never claim it) and `ci-job`
(requires the `ci` tag advertised only by CI-enabled runners).

## Trigger + config security

- Webhook signature is verified over the exact raw bytes (path-scoped
  `express.raw` in `httpMiddleware.js`) with `timingSafeEqual`; a missing or
  bad signature is rejected before JSON parsing. Body limit 2 MB.
- Dedupe by delivery id; a replayed id with a different payload hash is
  recorded as `conflict` and rejected.
- Supported events: `push` (branches + tags), `pull_request`
  (opened/synchronize/reopened), `check_run` (rerequested, ours only),
  `installation`/`installation_repositories` (connection sync), `ping`.
  Everything else is acknowledged and recorded as `ignored`.
- `.runyard/ci.yml` is always loaded from the **trusted base** (the
  repository default branch / push target ref), never from a PR head. The
  exact config SHA is pinned into `config_source` and run provenance.
- Fork/untrusted PRs: no repository secrets (compile strips secret names),
  no `native` executor, no privileged Dagger flags. Native execution requires
  repo `trust_policy.allowNative` AND runner opt-in
  (`RUNYARD_RUNNER_CI_NATIVE=1`).
- All job ids, needs-DAG (cycles, unknown refs), timeouts, env names, secret
  names, artifact globs (no absolute paths, no `..`), and working dirs are
  validated before anything is queued.

## Exact-source semantics

Provenance distinguishes `headSha` (provider-reported), `baseSha` (target
branch at receipt), the **tested** checkout, and `commit_sha` (check target).
For PRs the runner constructs the merge candidate deterministically by
fetching the pinned base and head SHAs and merging head into base in an
isolated workspace — every job of a pipeline tests the identical tree; a
conflict is a first-class `merge_conflict` blocked conclusion, never a silent
fallback to head. Pushes/tags test the head SHA directly. Workspaces live
under the runner's CI work dir, are path-contained, cleaned on success, and
retained (bounded) on failure.

## Orchestration

`src/ciOrchestrator.js` compiles a validated trigger+config into a pipeline
row, a parent run, and job rows. Ready jobs (all `needs` succeeded) are
dispatched as `ci-job` runs; the sweep (wired into the existing
`startRunMaintenance` interval) advances the DAG, skips or cancels dependents
of failed/cancelled jobs, reconciles the parent run terminal status from job
outcomes, emits keep-alive progress events so the stall reaper never reaps a
healthy pipeline, cancels superseded pipelines sharing a concurrency key, and
is idempotent across hub restarts (dispatch is guarded by job `phase` +
existing run rows; completed side effects are never replayed).

## Reporting

One check run per job (`runyard/<job>`), plus `runyard/ci` for pipeline-level
outcomes (config errors, merge conflicts). Status transitions map
queued -> in_progress -> terminal conclusion (success, failure, cancelled,
timed_out, skipped, action_required, neutral); infra errors are annotated as
infrastructure failure, distinguishable from code/test failure. Updates are
idempotent (stored check run id + external id = job id), retried with
backoff, and a reporter outage never affects run execution.

## Surfaces

- API group `ci` (grouped `/api/v1/ci/...` aliases): app config health,
  repo list/get/enable/disable/sync, config inspect/validate, manual
  dispatch, cancel/rerun, pipeline/job detail, webhook deliveries
  diagnostics. Admin scope for repo/trust mutation; `api` scope for
  dispatch/cancel; reads are any authenticated token.
- CLI: `runyard repo ...` and `runyard ci ...` groups.
- MCP: `list_ci_repositories`, `get_ci_pipeline`, `dispatch_ci_run`.
- Web: `#repositories` overview + detail, CI section on run detail.
- Docs: `docs-site/content/docs/concepts/ci.mdx` + `guides/ci.mdx`;
  `.runyard/ci.yml` reference; RunYard's own example config at
  `.runyard/ci.yml`.

## Observability

Run events `ci.pipeline.*` / `ci.job.*` carry OpenTelemetry-aligned fields
(`cicd.pipeline.name`, `cicd.pipeline.run.id`, `cicd.pipeline.task.name`,
`cicd.pipeline.result`, worker id, deep links). Operator diagnostics
(`GET /api/ci/diagnostics`) expose low-cardinality counters: webhook
signature failures, duplicate deliveries, queue latency, executor
mismatches, check-report failures, reconciliation lag.

## Explicit non-goals (this slice)

Git hosting/LFS, full Actions syntax, `act` compatibility, merge
queue/speculative gating, Kubernetes/Tekton, Marketplace billing, automatic
deployment, agent-driven pipeline decisions.
