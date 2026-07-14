# Goal: First-Class Paused / Resumable RunYard Workflows

Date: 2026-07-09
Repo: /home/xiko/runyard
Runner: Claude Fable (`claude --model claude-fable-5 --dangerously-skip-permissions`)

## User Context

Fran asked whether RunYard supports "paused" workflows. Smithers supports this, and RunYard needs it too. One clear scenario: the user runs out of credits. The workflow should be interrupted, but not necessarily failed yet.

Current RunYard has approval-style parking (`waiting_approval`, `engine.approval.waiting`) and Smithers resume plumbing (`__resume`, `smithers --resume`), but no general first-class `paused` lifecycle/status for quota/credit/provider interruption. Do not overload `failed`, `cancelled`, `budget_exceeded`, or `waiting_approval` for this.

## Hard Requirement

Implement first-class paused/resumable runs in RunYard:

- A run can enter a non-terminal `paused` state when execution is intentionally interrupted by a recoverable external condition.
- Initial intended reason: credits/quota/provider limit. Model it generically enough for future pause reasons.
- Paused is not success, failure, cancellation, budget exceeded, or human approval waiting.
- Paused runs must remain durable, visible, inspectable, and resumable.
- A paused run must not be reaped by liveness/deadline/stall logic.
- A paused run must not consume an active runner slot forever.
- Resuming should continue from the underlying Smithers checkpoint where possible, not rerun from scratch unless no checkpoint exists and the UI/API says so clearly.

## Desired Data Shape

Add an explicit run status:

```js
status: "paused"
```

Add pause metadata, keeping it additive/backwards-compatible:

```js
run.pause = {
  reason: "credits_exhausted" | "provider_limited" | "quota_exhausted" | "manual" | "unknown" | string,
  message?: string,
  pausedAt: ISODateString,
  pausedBy?: "runner" | "hub" | "operator" | "gateway" | "system",
  resumable?: boolean,
  resume?: {
    smithersRunId?: string,
    attempt?: number,
    strategy?: "smithers_resume" | "rerun_from_checkpoint" | "manual"
  },
  requiredAction?: {
    type?: "add_credits" | "reauth" | "operator_resume" | "unknown",
    label?: string,
    href?: string
  }
}
```

Shape can differ if the codebase has a better existing convention, but the output must preserve the same information.

## Lifecycle Semantics

- Valid transitions:
  - `assigned` / `running` -> `paused`
  - `paused` -> `queued` or `assigned`/`running` if resume immediately claims
  - `paused` -> `cancelled`
  - `paused` -> terminal failure only by explicit operator/system action, not automatic stall/deadline reaping
- `paused` is active/non-terminal for list grouping, but not runner-occupying after the active runner has safely released/cancelled/detached its child process.
- Existing terminal state behavior remains unchanged.
- `budget_exceeded` remains terminal for hard budget ceilings. Do not silently convert budget breach to paused unless an explicit future budget policy chooses that.

## Runner / Smithers Behavior

When the runner detects a recoverable interruption:

- Report a pause to the Hub with:
  - pause reason/message
  - current Smithers run id / checkpoint id if available
  - whether resume is possible
- The Hub transitions the run to `paused`, records pause metadata, emits a `run.paused` timeline event, and releases runner slot accounting.
- The runner should stop owning the detached Smithers child once RunYard has accepted the pause. If Smithers requires a cancel/suspend call for a clean checkpoint, use the correct Smithers primitive.
- Existing `__resume` launch path should be reused/hardened for resume.

Do not scrape vague stdout text for this as the only mechanism. If Smithers exposes a structured paused/provider-limited/credit event or state, use that. If it does not yet, make the RunYard side ready with a protocol endpoint and add a small adapter/classifier around the best currently available Smithers signal. Be explicit in docs/tests about what is structured today and what will improve when Smithers exposes richer pause reasons.

## API / MCP / CLI / UI

Add or update surfaces:

- HTTP:
  - read surfaces show `status: "paused"` and `pause`
  - runner protocol endpoint to pause a run, e.g. `POST /api/runs/:id/pause`
  - operator/client resume endpoint, e.g. `POST /api/runs/:id/resume`
  - cancel still works for paused runs
- `/api/v1/...` aliases should exist for new endpoints.
- MCP:
  - expose resume capability, e.g. `resume_run`
  - document paused status in run tools
- CLI:
  - add `runyard resume <runId>` if CLI patterns make this straightforward.
- UI:
  - Run list/detail visibly label paused runs.
  - Pause reason/required action should be visible.
  - Resume button/action appears when resumable.
  - Paused runs should group with active/in-flight or their own "Paused" group, not with failed terminal runs.

## Credit Exhaustion Scenario

Make the "user ran out of credits" path concrete:

- Introduce a pause reason such as `credits_exhausted` or `quota_exhausted`.
- A provider/agent/gateway response that clearly means no credits/quota should become `paused`, not `failed`, when the run can be resumed after replenishment.
- The paused run should carry a required action like "Add credits, then resume".
- Once credits are available, `resume` should requeue/reclaim and continue.

If exact live provider credit detection cannot be integration-tested safely, use deterministic fake provider/gateway tests that simulate the response.

## Tests / Gates

Add focused regression tests for:

- lifecycle transitions into/out of `paused`;
- paused is not terminal;
- liveness/stall/deadline reaper does not fail paused runs;
- runner slot accounting releases paused runs;
- run list/detail/timeline include pause metadata and `run.paused`;
- resume endpoint creates/claims the right resume input (`__resume` or local equivalent);
- cancel works from paused;
- MCP/OpenAPI parity includes pause/resume endpoints/tools;
- UI renders paused runs and resume controls;
- credit/quota exhaustion simulation pauses instead of fails.

Run and keep fixing until clean:

- `git diff --check`
- targeted tests for paused/resume/liveness/API/MCP/UI
- full `pnpm test`
- `pnpm build`
- `pnpm build:docs` if docs/discovery pages change
- syntax checks for touched JS files

## Release / Deploy

If implementation is successful:

- commit feature changes;
- cut the next semver release after `v0.6.0` (likely `v0.7.0`, unless repo conventions indicate otherwise);
- push `main` and tag;
- publish GitHub release;
- deploy/restart live RunYard on Hetzner/repo.box using existing repo conventions;
- verify live:
  - `/api/version`
  - `/readyz`
  - `/app`
  - `/openapi.json`
  - relevant docs/discovery text
  - a scratch/live paused run if safe, otherwise a scratch hub verification with fake credit exhaustion.

## Reporting Back

When done, report:

- release/tag/commit;
- what paused/resume semantics shipped;
- exact API/MCP/UI changes;
- tests and live verification evidence;
- any caveats, especially around Smithers' current pause signal fidelity.
