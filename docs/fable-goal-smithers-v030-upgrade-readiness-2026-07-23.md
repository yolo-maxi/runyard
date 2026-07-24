# Fable goal: Smithers v0.30 upgrade and RunYard replacement readiness

## Mission

Upgrade RunYard from `smithers-orchestrator` 0.22.0 to 0.30.0 comprehensively, then keep working until the branch is a release-candidate that Ocean can independently review and feel comfortable using to replace the current live RunYard deployment.

This is not a dependency-bump exercise. Audit and update every affected RunYard surface: runner/runtime integration, CLI, API/MCP, Web UI, workflow templates, installers and images, tests, operator behavior, and documentation. Adopt important new Smithers capabilities when they materially improve RunYard now. Capture larger opportunities as clearly scoped Kanban-ready ideas rather than building them speculatively.

## Hard boundary

- Work only in `/home/xiko/runyard` and on branch `upgrade/smithers-v0.30`.
- Do not deploy, restart services, change the live RunYard database, change global Smithers, cut a release/tag, merge to `main`, or replace the running 0.22 engine. Ocean will perform the live replacement later after an independent review.
- Do not push unless Ocean explicitly asks. Local commits are encouraged when the branch is coherent and green.
- Do not use repo.box as a build or agent machine. All installs, builds, tests, images, and real workflow smokes happen on this Hetzner host.
- Preserve unrelated user work. The branch started clean from RunYard `v0.11.17` commit `073e44f`.
- Use pnpm only for this repo. Smithers workflow execution itself may use the project-resolved Smithers/Bun CLI as required by upstream.
- Never expose credentials in logs, fixtures, artifacts, docs, or commits.

## Known baseline

- Canonical dependency and actual global runner binary: Smithers 0.22.0.
- Pins exist at least in `package.json`, `pnpm-lock.yaml`, `install.sh`, `Dockerfile.runner`, tests, and related comments/docs.
- Both active Hetzner runners currently resolve the global `smithers` 0.22.0 binary. Do not touch them in this pass.
- Runtime floor is satisfied: Node 24.18.0 and Bun 1.3.14. Smithers 0.27+ requires Node >=22 and Bun >=1.3.
- An isolated 0.30 smoke already proved the basic RunYard CLI contract: detached `up -d --format json`, run-id JSON parsing, `inspect --format json`, `events --json --limit`, and `output --json`. All six package symbols imported across the current 27 workflow-template files still export in 0.30.
- The upgrade crosses releases 0.23.0 through 0.30.0 and 3,312 upstream commits. Smithers 0.27.0 has real breaking changes: AI SDK 7 (`onStepFinish` -> `onStepEnd`), Node >=22, and retirement of old gateway sync primitives. RunYard does not appear to directly import those deprecated primitives, but prove this rather than assuming.
- Smithers 0.30 adds a much larger dependency surface. A clean isolated install resolved roughly 1,020 packages, showed peer warnings, and `pnpm audit --prod` reported transitive findings. Triage reachability and operational impact; do not wave them away or blindly treat every scanner finding as exploitable.

## Ground truth and research

1. Read every official release and upgrade/migration note from v0.23.0 through v0.30.0. Use official GitHub releases, the exact 0.30 package/source, and version-pinned Smithers docs. Do not rely on remembered APIs.
2. Build an explicit compatibility matrix mapping each relevant upstream change to:
   - unaffected;
   - required migration;
   - useful immediate integration;
   - deliberate deferral / Kanban idea;
   - rejected with rationale.
3. Inspect the exact 0.30 source for every CLI/API/event/status shape RunYard consumes. Upstream release prose is not enough for integration contracts.
4. Compare 0.22 and 0.30 package graphs, native/build-script requirements, peer warnings, audit findings, runtime floors, state/schema migrations, workspace paths, daemon behavior, and upgrade/rollback behavior.

## Required implementation scope

### 1. Version and distribution coherence

- Update every Smithers pin to exactly 0.30.0: application dependency, lockfile, installer defaults, runner image/build args, tests, examples, comments, docs, and any generated/distributed installer metadata.
- Keep the existing single-source-of-truth/version-pin regression test strong. Extend it if any pin surface is currently unguarded.
- Ensure project-local/global binary resolution remains deterministic. Document which binary each deployment shape uses and how its version is verified.
- Account for Smithers' new project-local delegation/update behavior so a global binary cannot silently execute a different version than the runner expects.

### 2. Runner and engine contract

Audit and harden the full contract, not only happy-path launch:

- detached launch success and new pre-spawn fail-fast behavior;
- JSON run-id parsing when 0.30 adds monitoring/CTA fields;
- inline and stdin large-input paths;
- `events`, `inspect`, `output`, `cancel`, resume/force, pause, terminal states, waiting states, quota states, approvals, and malformed/partial output;
- event cursors/sequence semantics, event replay, terminal closure, attribution, status mappings, and incremental polling opportunities;
- detached log relocation/retention introduced in 0.29;
- workspace state and checkpoint compatibility across an engine upgrade;
- gateway singleton/daemon behavior introduced in 0.27. Decide explicitly whether runner/container commands need `SMITHERS_NO_DAEMON=1`; do not allow an accidental unmanaged daemon fleet;
- 0.28 worktree cleanup defaults and preservation of dirty/unpushed worktrees;
- child environment containment, wrapper behavior, cancellation, shutdown, and secrets boundaries;
- approval provenance and whether RunYard's custom approval bridge/reaper logic is still necessary, should be simplified, or must remain. Do not remove proven RunYard behavior without equivalent end-to-end proof.

Turn every discovered behavior contract into a deterministic regression test or an explicit documented manual gate.

### 3. CLI surface

- Verify all existing RunYard CLI commands and runner setup/install flows against 0.30.
- Surface Smithers version/compatibility clearly in existing system, runner, or diagnostic output where an operator needs it.
- Evaluate new upstream commands and concepts (`monitor`, `oneshot`, `update`, `upgrade`, gateway management, packs, memory, alerts, cron, UI) against RunYard's product model.
- Integrate only low-risk, coherent capabilities now. Put larger or duplicative product opportunities into the opportunity backlog with rationale and acceptance shape.
- Ensure CLI help and errors tell operators what to do when versions drift or a launch fails before a run id exists.

### 4. API and MCP surface

- Audit all Smithers-derived status, event, run, approval, output, provenance, and error data exposed through RunYard API/MCP.
- Preserve API compatibility unless there is a compelling, documented migration.
- Integrate launch attribution/provenance and any important 0.30 state that RunYard currently discards, across storage, API, MCP, and docs, when the benefit is real and the data can be captured reliably.
- Revisit yesterday's streaming diagnosis. Evaluate cursor-based/replayable Smithers event following and whether it can eliminate RunYard's full-history rereads. Implement the safe engine-side improvement if it belongs in this upgrade and can be proven; otherwise create a precise Kanban idea.
- Keep API/MCP schemas, OpenAPI, discovery docs, and tests synchronized.

### 5. Web UI surface

- Audit the new `smithers-orchestrator/ui`, `gateway-ui`, live chat/fleet widgets, triage-first Monitor, run graph/canvas, approval/checkpoint components, and offline behavior.
- Do not blindly replace RunYard's established product UI with upstream Monitor widgets. Decide what is native RunYard product surface versus what can be safely reused or linked.
- Ensure any new data adopted above is visible where operators need it: attribution, engine version/drift, fail-fast launch errors, event-stream health, approvals, or other high-value state.
- For larger opportunities, add concise Kanban-ready ideas with the user value, why 0.30 enables it, likely surface, dependencies, and acceptance criteria.
- If UI code changes, run real browser checks on mobile and desktop widths, verify no overflow/clipping, and capture screenshot paths for Ocean's review.

### 6. Documentation and operator readiness

- Update README, docs site, install/runner/deployment docs, API/CLI docs, examples, and any embedded version references.
- Add a Smithers 0.22 -> 0.30 migration/rollback runbook covering preflight, state backup, canary runner, version verification, approval/pause/resume checks, failure rollback, and production promotion. This must be executable by Ocean later without reconstructing the investigation.
- Add the compatibility matrix and a concise replacement-readiness report stating what was changed, what was proved, residual risks, and the exact live cutover gates.
- Document the 0.30 feature-opportunity backlog. Make it suitable for insertion into the live RunYard Work board's Ideas lane. Do not mutate the live board in this Fable pass; Ocean will insert/dedupe the ideas during final review.
- Update release notes/changelog/version only if the repo's normal release process requires it for a release candidate. Do not tag or deploy.

## Opportunity review: minimum upstream surfaces to consider

Do not assume each deserves implementation. Evaluate at least:

- triage-first Monitor / “Needs you” operator view;
- live node chat, fleet table, stage strip, structured event log, and Monitor deep links;
- agentic UI kit: approvals, checkpoints, reasoning, tool calls, sources, prompt/attachments, plans, workflow canvas, charts;
- cursor/replay event streaming and incremental runner ingestion;
- launch attribution and engine-version provenance;
- detached fail-fast validation;
- first-class memory and XState folds;
- approval provenance and inline decision flows;
- gateway offline semantics and singleton lifecycle;
- `oneshot` as a focused task path;
- workflow packs/update/upgrade flows;
- browser viewer and security hardening;
- OpenClaw/Hermes/agent-plugin integrations;
- new sandbox providers and whether they matter to RunYard's runner model;
- cron, alerts, human task queue, hijack, time travel, worktree/checkpoint surfaces;
- reusable UI components versus RunYard's custom equivalents.

## Verification gates

Keep fixing until all applicable gates pass or document a concrete blocker with evidence.

### Static/package gates

- `git diff --check`
- exact pin-coherence tests
- clean `pnpm install` / lockfile consistency
- Node/Bun engine compatibility check
- production dependency audit with a reachability/mitigation note for every high or critical finding newly introduced or changed
- no unexpected lifecycle/build scripts; explicitly inspect ignored/required build scripts and native packages

### RunYard gates

- targeted tests for every modified contract
- full `pnpm test`
- `pnpm build`
- `pnpm build:docs`
- generated OpenAPI/discovery/CLI help consistency checks where applicable

### Smithers 0.30 contract gates

Use isolated temp workspaces/state. Do not touch active runner state.

- deterministic compute-only workflow: foreground and detached
- valid/invalid detached launch, proving fail-fast behavior and RunYard error handling
- inline input and stdin input
- inspect/events/output contracts and event-sequence behavior
- cancel a live waiting/timer run
- approval wait -> mirrored RunYard approval -> decision -> resume -> terminal success
- pause -> checkpoint metadata -> resume; also missing-checkpoint behavior
- failure, invalid output, timeout/quota/waiting mappings where they can be deterministically simulated
- runner shutdown/cancel-all behavior
- one representative existing RunYard workflow dry-run/graph validation per workflow family
- real runner-image build on Hetzner and container smoke proving `smithers --version` is 0.30.0 and the RunYard runner resolves that exact binary
- prove no accidental gateway daemon or orphaned workflow process remains after tests

### Product surface gates

- CLI smoke across changed commands/help/errors
- API + MCP smoke for changed run/event/approval/provenance fields
- browser smoke of changed Web surfaces at 360, 768, 1280, and 1680 widths
- docs build and spot-check the migration, operator, API, and CLI pages

## Completion standard

The task is complete only when:

1. Every code/config/install/image pin is coherently on Smithers 0.30.0.
2. The entire RunYard CLI/API/MCP/UI/docs surface has been audited and either updated, explicitly proven unaffected, or deliberately deferred with rationale.
3. The critical runtime flows above have real 0.30 evidence, not only unit mocks.
4. Full tests/build/docs and container smoke are green.
5. Security/dependency changes are triaged honestly.
6. A migration/rollback runbook and replacement-readiness report let Ocean perform an independent final review and later live replacement.
7. New opportunities are captured as deduplicated, Kanban-ready Ideas rather than silently ignored or prematurely built.
8. No production service, live database, global binary, release tag, or deployed artifact was changed.
9. The branch is clean except for intentional commits, and the final report lists commits, changed surfaces, exact test evidence, residual risks, proposed Ideas, and Ocean's remaining cutover checklist.

Do not stop at the first green test run. Review the diff as an operator, API consumer, runner maintainer, security reviewer, and product designer. Keep iterating until this branch is genuinely boring to replace production with.
