# Engine-approval bridge

Status: shipped on `runyard/engine-approval-bridge` (2026-07-04).

## Problem

PRs #9/#10 made Hub approval cards safe: blocking approvals hold a run open
forever, timed approvals resolve via fallback/autopilot or surface as
`fallback_required` — never a terminal failure. But a workflow can also pause
at an **engine-level Smithers `<Approval>` node** without any Hub involvement:
the engine parks the run as `waiting-approval` in its own SQLite store and
waits for `smithers approve|deny` on the runner box. Those pauses created no
Hub approval card and emitted no run events, so the Hub stall reaper failed
them as `run_stalled` after `RUN_STALL_MS` (default 15 min), and the runner's
own deadline could cancel them.

## Design

Two independent belts, both driven from the runner's existing poll loop
(`smithers inspect` was already called every tick — detection is free):

1. **Bridge (primary)** — `src/runnerEngineApprovals.js`, wired in
   `src/runner.js`:
   - Detect pending engine gates from inspect JSON (`runState.state ===
     "waiting-approval"` + the `approvals: [{nodeId, ...}]` array; verified
     against the pinned `smithers-orchestrator` 0.22.0 CLI).
   - Post `engine.approval.waiting` run event and create a Hub approval card
     (payload `kind: "engine_approval"`, keyed by `smithersRunId + nodeId`,
     idempotent across runner restarts). Cards are blocking — no timer.
   - Poll the card; when a human resolves it, apply the decision to the engine
     via `smithers approve|deny <sid> --node <nodeId>` (approved → approve;
     rejected/changes_requested → deny; anything else → never invent a
     decision). The engine validates node+iteration, so a mismatched apply
     fails closed and is reported as `engine.approval.apply_failed`
     (bounded retries, then explicit give-up message).
   - When the gate clears, post `engine.approval.resumed` with any engine-side
     decision observed in the event stream (`ApprovalGranted`/`Denied`); the
     Hub mirrors that decision onto a still-pending card
     (`resolveEngineApprovalOnResume`, resolvedBy `engine:cli`) so no phantom
     card lingers.

2. **Conservative guard (belt under the bridge)** — Hub-side
   `hasEngineApprovalWait(runId)`: a run whose latest per-node
   `engine.approval.waiting` event has no matching `engine.approval.resumed`
   is approval-held even if card creation failed. Wired into `runReapReason`
   (exempts both `run_stalled` and `max_runtime`; a dead runner heartbeat
   still wins) and into `runApprovalHold`, which the runner already reads to
   defer its execution deadline. Multi-gate workflows hold until the **last**
   gate resolves.

Existing PR #9 machinery does the rest: a pending engine card triggers
`hasPendingRunApproval` → reap exemption + `approvalHold: true` in run detail
→ runner deadline deferral.

### Card resolution is run-status-safe

`resolveApproval` only transitions the run row when the run is in
`waiting_approval` status. Engine-approval cards attach to `running` runs, so
resolving one never requeues/cancels the run — the decision reaches the
workflow only through the engine CLI apply.

## Operator surfaces (MCP / API / CLI readiness)

Engine-approval cards are ordinary `approvals` rows, so every existing surface
works on them with no new endpoints:

| Operation | API | CLI (`runyard`) | MCP | Web |
|---|---|---|---|---|
| See the hold | `GET /api/runs/:id` → `approvalHold: true` | `runs`/`run <id>` | `get_run_status` | run detail |
| List pending engine gates | `GET /api/approvals?status=pending` | `approvals` | `list_pending_approvals` | approvals view |
| Approve (applies to engine via runner) | `POST /api/approvals/:id/approve` | `approve <id>` | `approve_run` | card button |
| Reject (engine deny) | `POST /api/approvals/:id/reject` | `reject <id>` | `reject_run` | card button |
| Request changes (engine deny) | `POST /api/approvals/:id/request-changes` | `request-changes <id>` | `request_changes_run` | card button |
| Telegram | webhook buttons | — | — | — |
| Engine-side decision (bypass) | `smithers approve\|deny` on the runner box; card auto-resolves via `engine.approval.resumed` | | | |

All resolution paths converge on the same `resolveApproval` handler that PR
#9/#10 tests cover; the bridge polls card state, so it does not care which
surface resolved it.

## Test coverage

- `tests/runner-engine-approvals.test.js` — wait extraction, card body, CLI
  argv mapping (never invents decisions), decision observation from the event
  stream, bridge tick behavior (dedupe, apply-once, bounded retry/give-up,
  resumed events, multi-gate).
- `tests/run-query-records.test.js` — engine hold exempts `run_stalled` and
  `max_runtime`; `runner_offline` still wins.
- `tests/run-liveness.test.js` — DB-level: waiting event alone (no card) holds
  a backdated run against stall + deadline reaping; resumed releases the hold;
  multi-gate holds; engine-side decisions auto-resolve pending cards without
  touching the run row; human card resolution leaves a running run running.
- `tests/run-supervisor-records.test.js` — per-node hold from newest-first
  events (loop re-waits, Panel-style concurrent gates, synthetic node).
- `tests/approval-routes.test.js` / `tests/approval-http-routes.test.js` —
  engine card idempotency key + handler dedupe.
- `tests/run-lifecycle-routes.test.js` — resumed-event hook fires only for
  `engine.approval.resumed`.
- `tests/cli-mcp.test.js` — live-server surface proof: an engine card is
  listed via the `runyard approvals` CLI and MCP `list_pending_approvals`,
  approved via MCP `approve_run`, the running run stays running with the
  event-based hold intact, and the hold releases on `engine.approval.resumed`.

## Known gaps / follow-ups (readiness blockers to track)

1. **Iteration-scoped gates**: 0.22.0 `inspect` does not expose the approval's
   loop `iteration`; the bridge applies with the CLI default (0). A gate inside
   a loop at iteration > 0 fails the apply (fail-closed, visible as
   `engine.approval.apply_failed`) and needs an engine-side
   `smithers approve --iteration N`. Fixed upstream ≥0.25 (inspect exposes
   iteration); revisit when the pinned engine is bumped.
2. **Runner process crash mid-wait**: if the runner *process* dies, the
   heartbeat check reaps/adjudicates as `runner_offline` (correct). If only the
   assignment loop dies while the runner keeps heartbeating, the hold persists
   indefinitely — same contract as any blocking approval, but there is no
   automatic re-attach to the orphaned engine wait. Operator path: decide
   engine-side, or cancel the run.
3. **Terminal-run card hygiene**: a pending engine card on a run that later
   goes terminal is not auto-resolved (holds only affect active runs; the
   card remains as operator noise). Same pre-existing behavior as run-smithers
   checkpoint cards.
4. **Live-runner dogfood of the CLI apply step** (`smithers approve` executed
   by a real runner against a real paused engine): the Hub-side loop is proven
   end-to-end in `tests/cli-mcp.test.js`; the runner-side apply is covered by
   unit tests with a fake CLI. A staging run with a workflow containing a real
   `<Approval>` node remains the final proof.
