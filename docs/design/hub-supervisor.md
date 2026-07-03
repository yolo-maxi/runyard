# Design Brief: Hub-as-Supervisor (decouple supervision from the supervised run)

**Status:** active v0.11 direction · **Date:** 2026-06-26 · **Host:** single box (Hetzner, 77.42.89.161)
**Author:** Ocean (for Fran) · **Implements:** the "supervisor is too tightly coupled to its run" problem.

Current execution brief: `specs/v0.11-hub-native-supervision.md`.

July 2026 correction: do **not** keep expanding default `run-smithers`
wrapping for ordinary UI/API-created runs. That older direction is superseded
because live failures showed the wrapper can amplify child failures and drift
from Hub state. Hub-native supervision is the source-of-truth direction; direct
workflow execution is the default until Hub supervision owns retry/resume/repair
policy.

---

## 1. Problem

Supervision today is **in-band**: the `run-smithers` supervisor is itself a run that executes *on a runner*, wrapping a child run on the **same runner / same execution substrate**. So when the runner process dies (or is reaped), the supervisor dies *with* the very run it was supposed to rescue. A safety net that shares the failure domain of the thing it protects is not a safety net.

Concretely (confirmed in code):
- `src/supervision.js` + `src/runSmithersWatcher.js` hold the *correct* retry/repair/escalate brain (classify error → one-shot code repair for deterministic bugs, retry-from-checkpoint for transient, 3-strike escalate to operator approval; caps: `RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS=8`, `RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS=1` per error fingerprint).
- But that brain only runs *while the supervisor run is alive on a runner*. If the runner goes offline, the reaper (`src/db.js::reapStuckRunIds`, ~line 1502) just calls `transitionRun(id, "failed", …)` — it **releases the slot but does not resume the work**. The supervisor never gets to act because it's dead too.

## 2. Goal

Move supervision **up into the control plane (the hub)**: one independent, singleton, sequential reconcile loop that watches *all* runs across *all* runner processes and, when a run is orphaned or fails recoverably, **re-dispatches it** (resume from last checkpoint / repair / escalate) instead of just failing it. Execution stays distributed across runner processes; only the *decision* is centralized.

Non-goals (explicitly out of scope for this pass):
- Cross-machine portability. **It is all one box.** Hub, both runner processes, the DB (`/home/xiko/runyard/data/`), and the workspace (`/home/xiko/smithers-workspace`) are on the **same host and same local disk**. "Re-dispatch to another runner" means **another runner *process*, same machine, same disk** — the checkpoint + workspace a failed run leaves behind are already readable by any runner process. No state-shipping. (If runners are ever spread across hosts, durable/portable workspace becomes a separate future project.)
- Rewriting the classify/repair/escalate logic — it already exists in `runSmithersWatcher.js`; we *relocate/reuse* it, we don't reinvent it.

## 3. Key insight that makes this small

The hub **already** has every primitive needed:
- A singleton, sequential reconcile loop: the **reaper** (`setInterval` in `src/server.js`, calling `reapStuckRunsWithRetrospectives` → `reapStuckRunIds`). It already scans all runs every cycle and detects runner-offline (now 45s) and stall (15m).
- A re-dispatch primitive: setting a run to `status='queued'` with `runner_id=NULL` puts it back in the claim queue; the existing scheduler (`db.js` claim path, ~line 1971: `… status='assigned' … WHERE status='queued'`) will hand it to **whichever runner process has a free slot**. The auto-queue-after-approval path (`db.js:1248`, `UPDATE runs SET status='queued' … WHERE status='waiting_approval'`) already proves this pattern.

So **promote the reaper from "janitor" (fail + release) to "supervisor" (decide → requeue/repair/escalate)**. That is the whole change.

## 4. Proposed architecture

```
            ┌─────────────────────── HUB (control plane, singleton) ───────────────────────┐
            │  Reconcile loop (the promoted reaper, runs every N s, sequential):            │
            │    for each run in {assigned, running}:                                       │
            │      if runner offline > offlineMs  → ORPHANED                                │
            │      if no events  > stallMs         → STALLED                                 │
            │    for each run in {failed} not yet adjudicated:                              │
            │      classify(error) → {code_bug | transient | non_recoverable}              │
            │    decide(run) → RESUME | REPAIR | ESCALATE | GIVE_UP   (reuse watcher brain) │
            │      RESUME   : status→queued, runner_id→NULL, attempt++   (resume@checkpoint)│
            │      REPAIR   : spawn one-shot implement-change-gated repair child, then RESUME│
            │      ESCALATE : create operator approval card (3-strike / cap hit)            │
            │      GIVE_UP  : status→failed (terminal) once caps exhausted                  │
            └───────────────┬───────────────────────────────────────────────┬──────────────┘
                            │ queued runs                                    │ approval cards
                 ┌──────────▼──────────┐                          ┌──────────▼─────────┐
                 │ runner process A     │  …claims & executes…     │ runner process B   │  (same box, same
                 │ (cap 4)              │                          │ (support, cap 2)   │   /home/xiko/
                 └──────────────────────┘                          └────────────────────┘   smithers-workspace)
```

The in-band `run-smithers` envelope can be **slimmed to a pure executor** (it just runs the child and reports outcome + checkpoint), because the *decision* now lives in the hub loop and survives the executor's death. Keep it wrapping for the happy-path retry-while-alive (cheap, has live context), but the hub loop is the backstop that catches everything the in-band path can't (its own death).

## 5. State machine to lock before coding

Define precisely:
- **ORPHANED** = run in `assigned`/`running` whose runner's last heartbeat > `runnerOfflineMs` (45s). Has a checkpoint ⇒ resumable.
- **STALLED** = run in `assigned`/`running` with no new event for > `runStallMs` (15m). (Catch-all for a hung-but-alive runner.)
- **FAILED-RECOVERABLE** = `failed` with a recorded checkpoint (`checkpoint|lastCheckpoint|resumeFrom|resumeStep`) and attempts < cap.
- **Decision** (reuse `runSmithersWatcher` classifier + fingerprinting):
  - deterministic **code bug** + repair budget left + this fingerprint not already repaired → **REPAIR** then **RESUME**.
  - **transient/infra** → **RESUME** from checkpoint.
  - **3 identical-fingerprint failures** OR attempts ≥ `maxAttempts` (8) OR repair budget exhausted → **ESCALATE** to an operator approval card.
  - operator **cancellation** → never auto-resume (intent, not failure).
- **Caps / idempotency** (must-haves):
  - Per-run attempt counter + per-fingerprint repair counter persisted on the run (so caps survive a hub restart). Default `maxAttempts=8`, `maxCodeRepairs=1`/fingerprint — keep existing constants.
  - **Idempotent re-dispatch:** a run may be requeued at most once per reconcile tick; guard against double-dispatch (claim uses `WHERE status='queued'` conditional update — preserve that compare-and-swap so two ticks/processes can't both grab it).
  - **Lineage:** record each resume/repair attempt (prev runId/runner, reason, fingerprint, timestamp) so the dashboard shows the self-heal history and we can't silently loop.
  - **Loop-breaker:** if a run has been resumed N times with the *same* fingerprint and no forward progress (no new checkpoint advanced), stop → ESCALATE. Never infinite-resume.

## 6. Phased plan (each phase independently shippable + verifiable)

- **Phase 1 — Resume instead of fail (the 80%).** In the reaper, for an ORPHANED or FAILED-RECOVERABLE run with attempts < cap and a checkpoint: **requeue** (`status→queued`, `runner_id→NULL`, `attempt++`, lineage row) instead of `transitionRun(...,"failed")`. Existing scheduler re-dispatches to any free runner process; it resumes from checkpoint on the shared workspace. Escalate to approval when caps hit. *This alone closes the "they die together" gap.*
- **Phase 2 — Hub-side repair.** When the classifier says deterministic code bug, the hub loop dispatches the existing one-shot `implement-change-gated` repair (purpose `repair`) *before* the resume, bumping the per-fingerprint repair counter. Reuses the supervision bypass token path already in `decideSupervision`.
- **Phase 3 — Slim the in-band envelope (optional, later).** Reduce `run-smithers` to a thin executor now that the hub owns the decision; or leave it as a fast-path and let the hub be pure backstop. Decide after Phase 1–2 are proven.

## 7. Verification gates (the implementing run must prove these)

- [ ] **Unit:** orphaned run with checkpoint → reconcile requeues it (status `queued`, `runner_id` null, attempt incremented) rather than failing; without a checkpoint or past cap → fails terminally.
- [ ] **Unit:** idempotency — two reconcile ticks (or two processes) cannot double-dispatch the same run (compare-and-swap holds).
- [ ] **Unit:** loop-breaker — same fingerprint, no checkpoint progress, N times → ESCALATE, not infinite resume.
- [ ] **Live (single box):** start a run on runner A, `kill -9` runner A mid-run → within ≤ (offlineMs + one reconcile tick) the hub requeues it and **runner B picks it up and resumes from the last checkpoint** (not from scratch); final state `succeeded`. No leaked slot.
- [ ] **Live:** force a deterministic code-bug failure → hub triggers one repair, then resume → succeeds (Phase 2).
- [ ] **Live:** exhaust the cap → an operator **approval card surfaces** (don't regress the approval bridge fixed today).
- [ ] Full test suite green (currently 405/405); typecheck/lint if present. No regression to the slot model or reconcile-from-ground-truth fixes shipped earlier today.

## 8. Risks / tradeoffs

- **Hub does more.** Acceptable: it's already the singleton control plane and source of truth; folding supervision in adds no new failure domain (if the hub is down, nothing runs anyway). Keep the reconcile loop cheap (indexed queries, bounded batch per tick).
- **Resume-from-checkpoint correctness.** A resumed run must not re-execute already-committed side effects. Rely on the workflow's own checkpoint contract; if a step isn't safely resumable, mark it non-resumable and ESCALATE rather than blind-resume. Document which capabilities are resume-safe.
- **Stay-up vs correctness.** Same philosophy as today's hub-crash fix: prefer escalate-to-human over infinite auto-resume when uncertain.

---

### Code map (where to work)
- `src/db.js` — `reapStuckRunIds` (~1502, the fail→requeue change), `transitionRun` (~1593), claim CAS (~1971), attempt/lineage persistence (schema add).
- `src/server.js` — reaper interval `reapStuckRunsWithRetrospectives` (~3727/3950); wire the decision step.
- `src/runSmithersWatcher.js` — reuse `classifyChildRun`, fingerprinting, `recordRepairAttempt`, caps. Lift the decision helpers so the hub loop can call them without an in-band run.
- `src/supervision.js` — `decideSupervision` repair-bypass path (Phase 2).
- Tests: `tests/` (add reconcile/requeue/idempotency/loop-breaker cases alongside existing `run-liveness`/`runner-reaper`).

---

## Implementation notes (shipped 2026-06-26)

**Status: Phase 1 shipped + live-proven. Phase 2 decision logic shipped, dispatch flag-gated OFF. Phase 3 not done (deliberate).**

### What shipped, per phase

**Phase 1 — resume instead of fail (DONE, live-proven).**
- New pure module `src/hubSupervisor.js`: `decideReconcile(ctx)` returns `resume | repair | escalate | give_up`. It is DB-free and clock-free — the reaper extracts durable facts (reason, error, checkpoint, attempt/repair counters, loop-breaker progress marker) and passes them in. It *reuses* the watcher brain (`classifyWorkflowCodeFailure`, `normalizeErrorFingerprint`, and the caps constants `RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS=8` / `…MAX_CODE_REPAIRS=1` / `…FINGERPRINT_LIMIT=3`) rather than reinventing it.
- Schema (`src/db.js`, additive migration `migrateRunsSupervisorColumns` + `run_lineage` table): `runs.attempt`, `runs.repair_count`, `runs.supervisor_meta` (JSON: per-fingerprint resume/repair maps, last checkpoint, loop-breaker progress marker, `adjudicated` flag, `lastDecision`). Counters persist so caps survive a hub restart.
- `reapStuckRunIds` now routes a `runner_offline` (ORPHANED) run through `adjudicateRun`: RESUME requeues it via a **CAS-protected** raw `UPDATE … WHERE id=? AND status=?` (status→`queued`, `runner_id`→NULL, `attempt`++, `__resume` marker written into input, lineage row, slot released). STALLED / max-runtime keep the old terminal-fail (the runner may still be alive → blind resume would double-run).
- New `reconcileFailedRecoverable()` scan (bounded, indexed) handles runs a runner self-reported as `failed` that still carry a checkpoint — the same decision, but `observedStatus='failed'`.
- `src/runner.js`: `launch()` honors `input.__resume.smithersRunId` → `smithers up --resume <sid> --force`, so the rescuer reattaches to the prior **detached** Smithers run on the shared workspace and continues from the last checkpoint instead of starting fresh. Additive: no marker → byte-for-byte prior behavior. Strips `__resume` from the workflow input; emits `runner.resumed`.

**Phase 2 — hub-side repair (decision shipped, dispatch flag-gated OFF).**
- `decideReconcile` emits `repair` for a deterministic workflow-code failure when `enableRepair` is set and the per-fingerprint repair budget (1) is unspent; `adjudicateRun` calls an injected `dispatchRepair` callback, bumps `repair_count` + the per-fingerprint counter (never repairs the same fingerprint twice), then resumes. `src/server.js::dispatchHubRepair` creates the one-shot `implement-change-gated` run.
- Gated by `HUB_SUPERVISOR_REPAIR_ENABLED` (default **false**). With it off, `enableRepair=false`, so a code-bug failure **escalates to an operator card** instead — the safe behavior while the on-box **Codex CLI auth is expired** (an auto-repair agent would just fail). Flip the flag on once auth is restored; the decision + dispatch plumbing is unit-tested and ready.

**Phase 3 — slim the in-band envelope: NOT done (deliberate).** The in-band `run-smithers` envelope is kept as the happy-path fast retry-while-alive; the hub loop is the backstop that catches its own death. Touching the envelope risked Phase 1/2, against the brief's guidance. Left as a documented follow-up.

### Deviations from the brief
- **No double-supervision guard added (beyond the brief).** A run still supervised by a *live* in-band `run-smithers` parent is left to that parent (plain terminal-fail so the parent retries); the hub only adjudicates top-level/un-parented runs and the supervisors themselves. This prevents the hub and a live in-band supervisor both re-dispatching the same child. (`hasLiveSupervisingParent`.)
- **STALLED is escalate-only / terminal-fail, not auto-resumed.** Only `runner_offline` (runner confirmed dead) and a self-reported `failed` are resumed; a stalled-but-maybe-alive runner is never blind-resumed (resume-safety, §8).
- **Loop-breaker uses an event-count progress marker.** Because a resumed run keeps the *same* Smithers sid, "forward progress" is measured by the run's event count advancing, not by the checkpoint handle changing. Same-fingerprint + no marker advance, N times → ESCALATE.

### Resume-safe vs escalate-only
- **Resume-safe:** `runner_offline` orphan **with** a recorded Smithers sid, and self-reported `failed` **with** a sid, under caps. Resume reattaches to the durable Smithers run (idempotent at the workflow's checkpoint contract).
- **Escalate-only / terminal:** no checkpoint (→ terminal fail), operator cancellation (intent, never resumed), STALLED/max-runtime (possibly-live), attempt cap hit, loop-breaker tripped, repair budget exhausted, or a step the workflow marks non-resumable.

### Verification (gates §7)
- **Unit (`tests/hub-supervisor.test.js`, 16 cases):** orphaned+checkpoint→requeue / no-checkpoint→terminal-fail; idempotency (second tick can't double-dispatch — CAS holds); loop-breaker→escalate; cap→escalation card; failed-recoverable resume/skip-adjudicated/skip-no-checkpoint. Full suite **421/421** green (405 prior + 16 new). No lint/typecheck step in the repo.
- **Live (single box, deployed):** started `hello` on an ad-hoc victim runner, `kill -9` mid-run → at +92s the hub emitted `run.supervisor.resumed (attempt 1)`, a second runner process claimed it, emitted `runner.resumed`, re-dispatched the **same** Smithers sid `run-1782504150744` (proving resume-from-checkpoint, not from scratch), and reached `succeeded`; rescuer `active_runs=0` (no leaked slot); one `run_lineage` resume row. Separately, an orphan with `attempt` at the cap (8) produced a `supervisor_escalation` approval card (escalation=`max_attempts`) — the approval bridge is not regressed.
- **No regressions:** slot pools, ground-truth `reconcileRunnerActiveRuns`, loud runner auth, and hub-crash guards all intact; `runyard.service` active, `/healthz` 200, both runners online (4/4, 2/2).

### Follow-ups
1. Flip `HUB_SUPERVISOR_REPAIR_ENABLED=1` once on-box Codex (or another repair-capable) auth is restored, and add a live Phase-2 repair gate.
2. Phase 3: slim `run-smithers` to a thin executor now the hub owns the decision.
3. Surface `run_lineage` in the dashboard (self-heal history per run).
4. Consider a richer checkpoint-progress signal than event-count if workflows emit highly variable event volumes.
