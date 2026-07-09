# Fable Goal: First-Class Run Usage, Cost Metering, Budgets, and Release

Repo: `/home/xiko/runyard`
Date: 2026-07-08

## User Request

Fran asked for a new Fable/goal run:

RunYard should treat per-run cost/usage as a first-class streamed signal.

Today a run durably records status, events, logs, and artifacts, but not what it consumed. Every model call a run makes inside runner child agents should be captured as usage:

```js
{
  ts,
  model,
  provider,
  promptTokens,
  completionTokens,
  totalTokens,
  costMicros?
}
```

Usage should aggregate to:

```js
run.usage = {
  totalTokens,
  byModel,
  costMicros
}
```

Usage should be:

- emitted as run events/timeline entries as calls happen;
- accumulated into per-step/per-run totals;
- persisted on the run record;
- included in terminal status payloads;
- included in delegated-run adapter terminal results so callers can bill/cap against real usage;
- budget-aware via optional `run.budget = { maxTokens?, maxCostMicros? }`;
- hard-stopped before overspending when budget is breached.

Important architectural direction:

- Capture at the inference boundary, not by scraping child-process output.
- Route model calls through a metering gateway the runner is pinned to.
- The runner/child agents should not have ambient provider keys if the gateway path is enabled.
- Gateway should be egress-locked where feasible.
- This should be broadly useful: optimizer variance/failure/cost measurement, dashboard cost-per-run, runaway spend risk, and paid/delegated execution.

Push and cut a release after implementation.

## Current Context

Current live release before this work: `v0.5.0`.

Recent relevant changes:

- `v0.4.0` added API-first surface registry, Fumadocs docs, and release-triggered docs-update workflow.
- `v0.4.1` fixed DB workflow bundle materialization for relative imports.
- `v0.5.0` added grouped `/api/v1/...` aliases, deprecated capabilities, first-class `read` scope, token presets, and external shadow-client tests.
- Run events/timeline/logs/artifacts already exist and should be extended rather than replaced.

## Scope And Bias

Prefer a shippable end-to-end metering slice over an overbroad partial rewrite.

However, do not fake usage. If provider SDK/CLI layers cannot be forced through a metering gateway in one pass, implement the durable data model, event ingestion, aggregation, API/MCP/UI surfaces, budget enforcement hook points, and at least one real captured provider/gateway path with clear follow-up for fully egress-locking all child agents.

Do not claim full coverage for all child-agent calls unless verified.

## Part 1: Usage Data Model

Add durable usage records and run-level aggregates.

Requirements:

- Per-call usage record fields:
  - `id`
  - `runId`
  - optional `stepId` / `nodeId` / `agentLabel` if available
  - `ts`
  - `provider`
  - `model`
  - `promptTokens`
  - `completionTokens`
  - `totalTokens`
  - optional `costMicros`
  - optional metadata for request id / source / gateway
- Run-level aggregate:
  - `totalTokens`
  - `costMicros`
  - `byModel`
  - ideally by provider and by step if practical
- Persist aggregate on the run record or a stable joined store.
- Include `usage` in:
  - `GET /api/runs/:id`
  - `GET /api/runs`
  - terminal run status payloads
  - run timeline/diagnostics where appropriate
  - OpenAPI/MCP docs

## Part 2: Usage Events And Timeline

Usage should stream like first-class run data.

Requirements:

- Emit event type such as `run.usage` or `usage.recorded` when a call usage record arrives.
- Timeline should include usage events in order.
- UI should show run usage totals on run cards/detail/dashboard where appropriate.
- Logs should not be the only place to see usage.
- Tests should prove event emission and aggregation happen together.

## Part 3: Metering Gateway / Inference Boundary

Build the metering capture path at the inference boundary.

Target design:

- Runner provides child agents with a gateway URL/token/config for model calls.
- Provider keys live at the gateway/hub side, not ambient in child agent env.
- Gateway records usage response metadata from provider APIs.
- Gateway can enforce budget before/after calls.
- Child agents should be pinned to use the gateway where possible.

Implementation options:

- If the codebase already has a provider abstraction, extend it.
- If current child agents are CLI-based (`claude`, Codex, Pi, etc.), identify the realistic interception point and implement the best end-to-end slice:
  - gateway for HTTP provider calls already controlled by RunYard;
  - wrapper/proxy config for Pi/custom endpoints;
  - env injection that points supported agents at gateway;
  - hardening that strips direct provider keys from child env when gateway metering is enabled.
- Do not rely on parsing CLI stdout as the primary usage source.

Document coverage precisely:

- which provider/agent paths are metered now;
- which paths are not yet meterable because the CLI/provider does not expose usage through the gateway;
- what is needed for full egress lock.

## Part 4: Budgets

Add optional per-run budgets.

Input shape:

```js
budget: {
  maxTokens?: number,
  maxCostMicros?: number
}
```

Requirements:

- Accept budget at run creation/preflight/draft/schedule/workflow endpoint paths where a run can be created.
- Store the budget on the run.
- Expose it in run status.
- Before each metered call, check current aggregate + expected/known request; if budget is already exhausted, stop without making another provider call.
- After each metered call, if the total breaches the budget, terminate/cancel/fail the run with a clear status/reason before more provider calls.
- Emit budget events such as `run.budget.exceeded`.
- Make terminal status distinguish budget-stop from generic failure.
- Tests should prove max token and max cost enforcement.

## Part 5: Delegated/Paid Execution Adapter

The delegated-run adapter or workflow endpoint terminal response must include usage.

Requirements:

- Terminal result payload includes `usage`.
- Callers can see real token/cost totals.
- If budget stopped the run, adapter result includes budget stop reason and final usage.
- Tests should cover terminal result payload shape.

## Part 6: API/MCP/UI/Docs

Surface usage and budgets everywhere consumers need it.

Requirements:

- API:
  - run list/detail/status/timeline include usage where appropriate;
  - run creation schemas accept `budget`;
  - OpenAPI documents usage/budget fields.
- MCP:
  - run status/list/timeline tools expose usage;
  - run/create/preflight tools accept budget where applicable.
- UI:
  - run cards/details show usage totals without clutter;
  - dashboard has aggregate cost/token signal if practical;
  - budget stop is visible and understandable.
- Docs:
  - `/docs` explains metering, budgets, gateway coverage, and delegated billing result shape.
  - `llms.txt` mentions budget fields for run creation and usage fields in status.

## Part 7: Tests And Real Verification

Add deterministic tests:

- usage record normalization and aggregation;
- run event emission on usage record;
- timeline includes usage;
- run list/detail/status include usage;
- budget persistence and budget-stop transitions;
- delegated adapter terminal result includes usage;
- MCP/OpenAPI surface includes usage/budget;
- child env strips direct provider keys when gateway mode is enabled;
- at least one real or fake-provider metering-gateway flow captures usage without scraping logs.

Real verification:

- Run a safe live or scratch-hub workflow through the metered path.
- Verify usage events appear while running.
- Verify terminal run status contains aggregate usage.
- Verify a tiny budget triggers a clear budget stop.
- Verify no provider secrets leak into child env/logs/events/artifacts.

## Gates

Loop until clean or document a real blocker:

- `git diff --check`
- `pnpm test`
- `pnpm build`
- `pnpm build:docs`
- targeted usage/budget/gateway/delegated tests
- `node --check` on touched JS files
- live/scratch verification of usage events and budget stop

## Release / Publish

If implementation and gates pass:

- Commit changes.
- Push `main`.
- Cut next release after `v0.5.0`.
- Create GitHub release using repo convention.
- Deploy/restart:
  - `runyard.service`
  - `smithers-runner.service`
  - `smithers-support-runner.service`
- Verify:
  - `/api/version`
  - `/readyz`
  - `/app`
  - `/docs`
  - runners online/healthy
  - metered live/scratch run evidence

## Reporting

When done, report:

- Commit and release tag/URL.
- What is metered now.
- What is not yet metered and why.
- Usage/budget API/MCP/UI shape.
- Budget-stop behavior.
- Delegated adapter terminal result behavior.
- Gate results.
- Live/scratch verification evidence.
