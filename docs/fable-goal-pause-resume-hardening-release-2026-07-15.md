# Goal: Pause / Resume as a Fully Supported RunYard Lifecycle

Date: 2026-07-15
Repo: /home/xiko/runyard
Runner: Claude Fable (`claude --model claude-fable-5 --dangerously-skip-permissions`)

## Context

RunYard v0.7.0 introduced first-class `paused` runs and v0.8.0 made paused/budget/approval work visible in the needs-attention queue. Fran now wants pausing and restarting to be not merely possible, but fully supported.

Current state to verify before editing:

- `paused` is a non-terminal status.
- `run.pause` records reason, message, required action, resumability, and optional Smithers checkpoint.
- `POST /api/runs/:id/pause`, `POST /api/runs/:id/resume`, MCP `pause_run` / `resume_run`, CLI `runyard pause` / `runyard resume`, and web resume controls exist.
- Gateway upstream credit/quota exhaustion can pause instead of fail.
- Runner can classify credit/quota failure text and report pause with a Smithers run id.
- Resume re-queues the same run and injects `input.__resume` when a checkpoint exists.

Do not duplicate this work. Audit it, then harden the gaps that keep it from feeling like a product-supported lifecycle.

## Product Bar

Treat pause/resume as a first-class operator lifecycle with these guarantees:

1. A paused run is visibly parked, never silently failed by liveness/deadline/stall cleanup, and never consumes runner capacity.
2. Operators can intentionally pause, cancel, inspect, and resume a paused run from Web/API/MCP/CLI.
3. Credit/quota exhaustion is paused rather than failed whenever it is recoverable.
4. Resume uses the recorded Smithers checkpoint when one is available.
5. If a checkpoint is missing, stale, or unrecoverable, the system says so explicitly and offers the correct fallback instead of pretending the resume worked.
6. A real/scratch proof demonstrates pause -> slot release -> resume -> terminal outcome.
7. Docs, discovery text, OpenAPI/MCP descriptions, CLI help, and UI all describe the same semantics.

## Required Investigation

First map current implementation and write down the gaps in the commit or docs:

- `src/runPause.js`
- `src/runPauseStore.js`
- `src/runLifecyclePolicy.js`
- `src/runLifecycleRoutes.js`
- `src/runner.js`
- `src/runnerSmithersRuntime.js`
- `src/runReadRoutes.js`
- `web/components/AttentionStrip.jsx`
- `web/components/RunDetailParts.jsx`
- `src/mcp.js`
- `src/mcpTools.js`
- `src/cli.js`
- pause/resume tests and docs

Pay special attention to:

- whether `smithers cancel` preserves a checkpoint that `smithers up --resume <sid>` can actually resume from;
- whether resume failure becomes a clear state/event instead of a confusing generic failure;
- what happens when the original runner holding the checkpoint is offline;
- whether paused runs are queryable and actionable enough from all surfaces;
- whether a user can distinguish `paused`, `waiting_approval`, `provider_limited`, and `budget_exceeded`;
- whether a scratch live/simulated run proves the lifecycle end to end.

## Implementation Targets

Make the smallest set of changes needed to satisfy the product bar. Likely targets:

- Add/strengthen tests for checkpoint resume and checkpoint-missing behavior.
- Add an explicit resume failure event/status path if a recorded checkpoint cannot be resumed.
- Improve attention/detail UI copy so paused runs say what to do next and when resume will be checkpointed vs rerun.
- Improve CLI output for `attention`, `pause`, and `resume` if JSON-only responses are not operator-friendly enough.
- Ensure OpenAPI/discovery/docs mention resume strategies and failure/fallback behavior.
- Add a deterministic scratch-smoke script or test fixture that simulates:
  - running run with active runner slot;
  - pause from operator or credit exhaustion;
  - runner slot release while runner id remains pinned;
  - resume;
  - successful completion from checkpoint or explicit fallback when no checkpoint exists.
- If Smithers already emits a structured pause/credit signal, use that instead of text classification. If it does not, document the adapter boundary honestly and keep the classifier narrow.

## Non-Goals

- Do not redesign all run statuses.
- Do not merge `paused` with `waiting_approval`.
- Do not convert budget stops into pauses; `budget_exceeded` stays terminal.
- Do not make broad UI redesigns unrelated to pause/resume.
- Do not run builds/tests on repo.box. Build and verify on Hetzner; deploy only audited/release output through existing RunYard conventions.

## Gates

Keep fixing until all relevant gates pass, or document a real blocker with evidence:

- `git diff --check`
- targeted pause/resume lifecycle tests
- targeted runner resume/checkpoint tests
- targeted API/MCP/OpenAPI parity tests
- targeted UI render/smoke tests for paused run detail and attention queue
- `pnpm test`
- `pnpm build`
- `pnpm build:docs` if docs/discovery changed
- `node --check` for touched JS entrypoints where useful
- scratch smoke proving pause -> resume behavior, preferably with a temporary isolated Hub/data dir

## Release / Deploy

If implementation is clean and scoped:

- commit the feature/hardening work;
- cut the next semver release after `v0.8.0`;
- push `main` and tag;
- let CI build/release;
- deploy/restart live RunYard through existing repo conventions;
- verify live:
  - `/api/version`
  - `/readyz`
  - `/app`
  - `/docs/concepts/runs/`
  - `/openapi.json`
  - CLI/API attention or a safe scratch paused run

## Report Back

Report concisely:

- whether pause/resume is fully supported after the pass;
- release/tag/commit;
- exact behavior for checkpointed resume, no-checkpoint resume, and failed resume;
- API/MCP/CLI/UI/docs changes;
- gates and smoke evidence;
- any remaining caveat that would matter in production.
