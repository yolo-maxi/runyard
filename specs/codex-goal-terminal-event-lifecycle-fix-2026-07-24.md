# Goal: fix false `run_stalled` after successful agent completion

Fix RunYard's terminal-event/lifecycle handling so a gated implementation run
cannot be marked stalled after its coding agent has already completed, committed,
and pushed successfully.

## Concrete production evidence

- Hub run: `run_0dc99254d15bf40159ed`
- Smithers run: `run-1784909133764`
- The Hub received the last streamed `AgentEvent` at `2026-07-24T16:11:00Z`.
- The coding agent then created and pushed commit
  `bda518d554d762a7217a3ca988916cab64dc3f1f` at `16:11:16Z` on
  `runyard/implement-change-gated/master/run_0dc99254d15bf40159ed`.
- No terminal agent/workflow event reached the Hub.
- At `16:26:46Z`, the Hub falsely failed the run with
  `run emitted no events within stall window`.
- The worktree and remote branch were clean and usable, contradicting the Hub
  outcome and the watcher report.

This is not just a timeout-tuning task. Find the exact lifecycle break between
the Codex agent process, Smithers task completion, runner event ingestion, and
Hub terminal reconciliation.

## Required behavior

1. Reproduce the failure deterministically with a focused test/harness. Model
   the important race: the agent's last streamed event precedes its final
   commit/push and/or process exit, and no further ordinary event arrives.
2. Inspect current RunYard runner ingestion and Smithers 0.30 upstream source at
   `/home/xiko/smithers-upstream`. Use the actual event/process semantics; do
   not guess.
3. Ensure the runner observes the authoritative Smithers/agent process terminal
   result even when the incremental event stream becomes quiet or closes
   without a final event.
4. Do not treat an active child process or recently completed successful
   process as stalled merely because no new user-facing event was emitted.
5. On stream EOF, process exit, watcher reconnect, runner restart, or temporary
   event-ingestion interruption, reconcile from durable Smithers state and
   produce exactly one correct Hub terminal outcome.
6. Preserve true stall detection for genuinely wedged runs. Do not merely
   lengthen or disable the stall window.
7. Make terminal reconciliation idempotent and race-safe. A late stale-failure
   path must not overwrite a successful/failed/cancelled authoritative
   terminal state.
8. Preserve branch/worktree outcome metadata so watchers never claim
   "no usable branch" when a clean pushed branch/commit exists.
9. If the root cause is in the live copied workflow/runtime under
   `/home/xiko/smithers-workspace`, change the source-of-truth files in this
   repo and document the required sync/deploy step. Do not edit the live copy
   as the primary fix.
10. Add regression coverage for:
    - quiet period followed by successful process exit;
    - stream EOF followed by durable terminal reconciliation;
    - late stale detector racing with a terminal success;
    - genuinely stalled process still failing;
    - committed/pushed branch metadata retained in diagnostics/outcome.

## Investigation notes

- Query only targeted rows from `/home/xiko/runyard/data/runyard.sqlite`; do not
  dump full event histories.
- Relevant areas likely include `src/smithers-runner.js`, runner event
  ingestion/follow logic, stale-run reconciliation, `runSmithersWatcher`,
  workflow templates, and Hub completion/failure endpoints.
- Check whether Smithers 0.30's event watcher exits before the agent process
  final result, whether RunYard conflates event silence with process liveness,
  and whether the Hub stall detector ignores authoritative local process state.
- Keep the fix generic across Codex/Claude/Pi and all workflows.

## Evaluation gates

Keep fixing until all applicable gates are clean:

- focused new lifecycle/race regression tests;
- existing runner/watcher/stale-run tests;
- `pnpm test`;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm build`;
- `pnpm build:docs`;
- `git diff --check`;
- targeted secret/private-path scan of the diff.

Perform a self-review of concurrency, idempotency, failure semantics, and
backward compatibility. Commit and push only
`runyard/terminal-events-fix`. Do not merge, release, deploy, restart services,
or modify production state. Return the root cause, changed files, test evidence,
commit SHA, and any required operator sync/restart steps.
