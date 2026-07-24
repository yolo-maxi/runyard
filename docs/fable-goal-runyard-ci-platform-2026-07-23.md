# Fable Goal: RunYard CI Platform + GitHub App Bridge

## Mission

Implement the first production-shaped CI slice inside RunYard. GitHub remains the canonical repository, pull-request, tag, release, and package surface. RunYard becomes the external CI control plane and executes work on RunYard runners without consuming GitHub Actions minutes.

This is not a Git-hosting project. Do not build a Git remote, SSH Git server, LFS, repository storage service, or general GitHub Actions clone in this pass.

The target loop is:

`GitHub event -> verified and deduplicated delivery -> immutable commit/merge candidate -> RunYard CI run -> isolated jobs -> evidence/artifacts -> GitHub Check -> merge/release decision`

Work autonomously through discovery, design, implementation, review, and verification. Keep fixing until the required gates pass or a genuine external blocker is documented with exact evidence. Use the hard-task method and existing repo-local patterns. Preserve unrelated work and do not modify the main checkout or other active worktrees.

## Repository and branch

- Work only in `/home/xiko/runyard-worktrees/ci-platform-fable`.
- Branch: `feature/ci-platform-fable`, based on `origin/main` at `073e44f` / RunYard `0.11.17` when launched.
- Other active Fable workers are changing the main checkout and `/home/xiko/runyard-worktrees/cli-stream-follow-fable`; do not touch, reset, merge, or depend on their uncommitted work.
- Build and test on Hetzner only. `repo.box` is publish/serve-only and must not run builds, installs, agents, or tests.
- Do not deploy production. Finish with a clean, pushed feature branch and a draft PR only if all required gates pass.

## Product and architectural intent

Continuous Integration is a trust loop around the shared mainline. For each candidate change, RunYard must answer: “Would this exact change, integrated with the current target branch, satisfy the repository's declared invariants?”

RunYard already owns durable runs, runner scheduling, events/logs/artifacts, approvals, secrets, retries, worktree isolation, repo mutation leases, promotion, UI/API/CLI/MCP surfaces, and post-run hooks. Reuse those systems. Do not introduce a second independent scheduler, run lifecycle, artifact store, approval system, or generic workflow engine.

Use this layering:

1. GitHub/SCM edge: Octokit GitHub App primitives and signed webhooks.
2. RunYard CI domain: provider-neutral repository, trigger, pipeline, job, and evidence records mapped onto canonical RunYard runs.
3. RunYard runner: exact-source checkout and job dispatch using existing capacity and lifecycle semantics.
4. Execution adapters:
   - a small native command adapter for explicitly trusted repositories/runners;
   - a Dagger adapter boundary for reproducible containerized build/test jobs, with a real availability probe and invocation path if Dagger is installed;
   - no Kubernetes/Tekton implementation and no `act` compatibility in this pass.
5. GitHub reporter: Checks API state, annotations, reruns, and deep links back to RunYard.

Prefer direct `@octokit/app` / Octokit webhook primitives over a standalone Probot service because RunYard already owns the Express process, routing, auth, configuration, audit log, and lifecycle. Prefer the smallest dependencies that fit the existing ESM/Node architecture. Use pnpm only.

## Required product slice

### 1. Provider-neutral repository and CI model

Add the smallest durable schema that cleanly supports GitHub now and other forges later. Exact names are your judgment, but the model must represent:

- SCM connection/installation identity without persisting installation access tokens;
- repository identity, provider, owner/name, clone URL, default branch, installation reference, enablement, trust policy, and timestamps;
- pipeline/config identity and trusted source revision;
- CI trigger provenance: provider, event type/action, delivery id, repository, ref, head SHA, base SHA, tested SHA/merge candidate, PR number, sender, and receipt time;
- pipeline/job execution linked to the canonical RunYard run id rather than a parallel status universe;
- GitHub check suite/run ids and last reported state;
- webhook receipt/idempotency state with bounded retention.

Status must remain reconciled with the existing RunYard run lifecycle. Avoid writable duplicate status fields where a derived/reference relationship is safer.

Add migrations/bootstrap handling, repository/service modules, APIs, audit events, serialization, and tests consistent with existing code organization.

### 2. GitHub App configuration and secure webhook ingress

Implement documented configuration for a GitHub App, including app id, private key supplied securely by path/secret material, webhook secret, public app/install URL, and optional API base for tests/enterprise compatibility.

Add a dedicated webhook endpoint that:

- reads the raw request body needed for HMAC verification without weakening global body limits;
- verifies the GitHub signature before trusting or parsing the event;
- deduplicates by GitHub delivery id with payload hash/conflict detection;
- records a concise audited receipt without storing secrets or gratuitous full payloads;
- accepts only explicitly supported events/actions and safely acknowledges ignored ones;
- is replay-safe across duplicate delivery, process restart, and retry;
- has strict body/time limits and useful error classification.

Support at least:

- `push` for configured branches and tags;
- `pull_request` opened, synchronize, reopened, and relevant target changes;
- `check_run` rerequested for checks owned by this App;
- installation/repository selection changes needed to keep connections synchronized;
- manual CI dispatch through authenticated RunYard API/CLI for dogfood and recovery.

Installation tokens must be generated just in time, scoped to the installation/repository/permissions needed, never stored in the database, never written to logs/artifacts/events, and never passed into arbitrary agent or repository commands. Centralize redaction and token-use boundaries.

### 3. Trusted `.runyard/ci.yml` configuration

Design and implement a deliberately small versioned schema. Do not recreate all GitHub Actions syntax.

The first schema should cover:

- event triggers for pull requests, branch pushes, tags, and manual runs;
- path/branch/tag filters with deterministic matching;
- named jobs with `needs` dependencies forming a validated DAG;
- executor selection (`native` or `dagger`);
- commands or Dagger module/function invocation;
- working directory, timeout, non-secret environment values, secret references, and artifact/test-report declarations;
- concurrency group and cancel-superseded behavior;
- required/optional job semantics and clear failure/skip/cancel conclusions.

Security rules:

- CI configuration for an untrusted PR must come from the trusted base/default branch, not the PR head.
- Fork/untrusted contexts receive no repository secrets and cannot request native host execution or privileged Dagger capabilities.
- Native execution is disabled by default unless both the repository trust policy and runner configuration allow it.
- Validate all paths, refs, job ids, dependency graphs, timeouts, commands, artifact globs, and secret names before queueing work.
- Pin the exact configuration source SHA and include it in run provenance.

Provide clear validation errors through API/UI/CLI and documentation. Include a minimal example configuration for RunYard itself.

### 4. Exact source and integration-candidate semantics

CI must be SHA-pinned and must distinguish:

- provider-reported head SHA;
- base SHA/default-branch state;
- tested checkout SHA or synthetic merge candidate;
- SHA receiving the GitHub Check.

For pull requests, test the provider's merge candidate when available, or deterministically construct/fetch the merge candidate using a documented safe fallback. Never silently claim an integration test when only the raw head commit was tested. Surface “merge candidate unavailable/conflicted” as a first-class blocked/failure conclusion with evidence.

Use isolated temporary worktrees/workspaces with path containment. Clean them after successful terminal completion, preserve actionable evidence on failure according to bounded retention, and never mutate the operator's source checkout. Reuse existing worktree/promotion safety patterns where applicable.

### 5. CI orchestration on existing RunYard runners

Compile a validated CI config/event into a canonical RunYard parent run and durable job execution. Reuse the runner queue/capacity/heartbeat/stall/cancel/retry machinery.

Required behavior:

- DAG dependencies and parallel ready jobs;
- queued, running, succeeded, failed, cancelled, skipped, timed-out, and blocked/error distinctions;
- job and pipeline cancellation, including cancel-superseded on a newer event for the same concurrency key;
- idempotent restart/recovery without replaying completed external side effects;
- per-job logs/events and bounded output;
- artifacts and test evidence attached through existing artifact records;
- separation of code/test failure from CI infrastructure failure;
- no secret values in child process listings, argv, logs, events, artifacts, or error payloads.

Do not use an LLM for deterministic CI plumbing. Agents may be explicit jobs/workflows later, but the core pipeline executor must be deterministic.

### 6. Native and Dagger execution adapters

Implement a clean executor interface.

Native adapter:

- explicit trust-policy gate and runner allowlist;
- argv/shell behavior documented and tested;
- process-group cancellation and timeout cleanup;
- sanitized environment and explicit cwd/path containment;
- bounded streaming logs and exit metadata.

Dagger adapter:

- detect availability/version and report a clear blocked/infrastructure error when unavailable;
- invoke a configured Dagger module/function without exposing GitHub installation tokens;
- support source input, explicit non-secret args, RunYard secret references through a non-logging channel, timeout/cancellation, and structured output/artifact references where practical;
- keep Dagger optional so RunYard boots and native trusted tests continue without it;
- document installation and runner capability advertisement.

Do not auto-install Dagger and do not add Dagger Cloud as a dependency. The open-source local engine is the intended backend.

### 7. GitHub Checks reporter

Create/update GitHub Check Runs for configured pipeline/jobs using the installation-authenticated client:

- queued -> in progress -> terminal conclusion;
- stable external id mapping to RunYard run/job ids;
- details URL to the authenticated RunYard run view;
- concise summary plus bounded annotations for recognized findings/test failures;
- correct mapping for success, failure, cancelled, timed out, skipped, neutral/action-required, and infrastructure error;
- rerequest handling without duplicating the original run;
- robust retry/backoff/rate-limit handling and idempotent update behavior;
- reporter outage must remain distinguishable from job failure and recoverable without rerunning successful jobs.

Batch and cap annotations to GitHub limits. Store only the minimum provider response identifiers needed for reconciliation.

### 8. API, CLI, MCP, Web UI, and docs

This cannot be web-only magic. Add coherent surfaces following RunYard's current grouped API and scoped-token conventions.

At minimum expose:

- GitHub App configuration health without secret values;
- list/get/enable/disable/sync repositories;
- inspect validated CI configuration and trust policy;
- manual dispatch and cancel/rerun;
- pipeline/job status, provenance, logs/artifacts links, and GitHub check link;
- webhook delivery diagnostics and reconciliation action for operators;
- CLI equivalents for repository list/sync and CI dispatch/status;
- MCP tools only where they provide real agent/operator value and preserve scoped authorization.

Add a calm, production-quality UI integrated into the existing app navigation:

- Repositories/CI overview with connection health and recent runs;
- repository detail with default branch, trust/executor policy, config status, and recent checks;
- CI provenance/job graph on run detail;
- clear empty, unconfigured, signature-error, config-error, runner-missing, cancelled, and blocked states;
- responsive behavior and keyboard/accessibility parity with existing surfaces.

Do not redesign unrelated areas. Build the production web bundle and update docs/OpenAPI/LLM discovery surfaces as required.

Document:

- conceptual CI model and ownership boundary between GitHub and RunYard;
- GitHub App registration, exact minimum permissions/events, webhook URL, setup/install flow, and secret handling;
- `.runyard/ci.yml` reference and examples;
- runner setup, native trust policy, Dagger setup, and troubleshooting;
- fork security and why config is loaded from the trusted base;
- migration path from GitHub Actions, while explicitly marking `act` compatibility, merge queue/Zuul-style speculative gating, Kubernetes/Tekton, full release automation, and Git remote hosting as follow-ups unless you can add them without destabilizing the core slice.

### 9. Observability and standards

Use existing RunYard events and metrics, but align new naming/result fields with OpenTelemetry CI/CD semantic conventions where practical:

- pipeline and task/job run identity;
- success/failure/error/timeout/cancellation/skip distinction;
- worker identity and deep-link URLs;
- low-cardinality metrics for queue time, run time, result, executor, and repository/provider.

Add operator-visible counters/diagnostics for webhook verification failures, duplicate deliveries, queue latency, runner/executor mismatch, check-report failures, and reconciliation lag. Do not create high-cardinality metric labels from raw refs, SHAs, or repository URLs.

## Explicit non-goals

- No Git remote/server, LFS, repository backup, or replacement for GitHub.
- No full GitHub Actions syntax/runtime clone.
- No `act`, Tekton, Kubernetes, Woodpecker, or Zuul service dependency in the core implementation.
- No GitHub Marketplace billing/productization.
- No automatic production deployment.
- No arbitrary secret access for fork PRs or repository-controlled config.
- No agent-generated pipeline decisions in deterministic CI plumbing.
- No second queue, scheduler, artifact store, or approval system beside RunYard's existing primitives.

## Required evaluations

Create targeted tests first where useful, then keep fixing until all relevant gates are green:

1. `git diff --check`
2. syntax/type/static checks used by the repository for every touched JS/TS/JSX file
3. focused unit tests covering:
   - signature verification and raw-body limits;
   - delivery dedupe/replay/conflict;
   - installation-token lifecycle/redaction;
   - repository/config schema and migration;
   - trusted-base config selection and fork secret denial;
   - trigger/path/ref matching and DAG validation;
   - exact SHA/merge-candidate provenance;
   - native trust/path/env/process cancellation;
   - Dagger available/unavailable behavior;
   - concurrency/cancel-superseded and restart idempotency;
   - GitHub Check transitions, annotations, retries, reruns, and reconciliation;
   - API/CLI/MCP scope enforcement;
   - UI rendering and empty/error states.
4. full `pnpm test`
5. `pnpm build`
6. `pnpm build:docs`
7. OpenAPI/CLI/MCP discovery parity checks
8. browser checks on a disposable local server at desktop and mobile widths, including no horizontal overflow and working repository/CI navigation
9. a deterministic end-to-end fake-GitHub fixture: signed webhook -> dedupe -> CI run -> isolated job -> artifact/log evidence -> mocked Check updates
10. if safe and credentials exist, an opt-in real GitHub App canary on a disposable branch/repository; never expose credentials and do not make this a requirement when credentials are absent.

Do not weaken, skip, or rewrite unrelated tests merely to make the suite pass. Classify genuine pre-existing/environment-specific failures with base-branch evidence.

## Security review checklist

Before declaring completion, explicitly audit and report:

- webhook signature verification and replay behavior;
- installation token lifetime, scope, persistence, argv/env/log exposure;
- fork PR and untrusted config behavior;
- path traversal, malicious refs, symlink escape, artifact glob escape;
- shell/command injection boundaries;
- process cleanup after cancel/timeout/crash;
- secrets in errors, events, metrics, artifacts, snapshots, and browser payloads;
- SSRF/API base configuration;
- duplicate provider side effects after retry/restart;
- runner capability spoofing and native-execution policy.

## Completion and handoff

When implementation and gates are clean:

- self-review the diff for architecture drift, duplication, security, and UX coherence;
- update relevant docs/changelog/version only if the repository's feature-branch convention calls for it; do not tag or deploy;
- commit logically, push `feature/ci-platform-fable`, and open a draft PR with a concise architecture summary, security notes, test evidence, screenshots, and explicitly deferred work;
- leave both the worktree and main checkout clean;
- print the branch, commits, PR URL if created, changed architecture, exact test counts/gates, screenshots, real-vs-mocked integration evidence, and any blockers or follow-ups.

The bar is a coherent, auditable CI foundation that dogfoods RunYard's existing durable machinery—not a superficial webhook demo and not a second CI product hidden inside RunYard.
