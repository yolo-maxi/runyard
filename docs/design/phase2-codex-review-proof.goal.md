# GOAL (Codex): Critically review the Phase-2 substrate fix, then prove it live end-to-end

Working dir: `/home/xiko/runyard` (Hetzner, single box). A Claude run implemented the Phase-2
hub-repair substrate fix and committed it at **`fb49a91`** (full suite 432/432 green). Your job
has TWO parts: (A) an independent, skeptical CODE REVIEW of that commit, and (B) a live
end-to-end proof with real Codex. You are a second pair of eyes from a different engine — be
adversarial, look for what the first pass missed. We intend to deploy tonight, so be rigorous but
efficient.

## Context: what fb49a91 changed (verify these claims, don't trust them)
- `src/hubSupervisor.js::buildHubRepairInput()` — repair child forced onto a dedicated branch
  (`smithers-self-repair`, NEVER main), inherits the failed run's runner routing
  (`__execution.runnerLocation`), forwards the repo selector. Closes the original safety hole
  (repair pushing to main on an arbitrary/prod runner).
- `src/db.js::requeueRunFresh()` + `reconcileRepairChildTerminal()` — the failed parent is PARKED
  (`awaitingRepair`) while the one-shot repair child runs; on repair child success the parent
  RE-RUNS FRESH (drops `__resume` marker — because smithers 0.22 refuses resume across a source
  change), on failure/cancel it escalates. Claimed idempotent (completion can't double-dispatch).
- `src/server.js` — wires the repair-completion hook (`reconcileRepairChildTerminal`) on run
  terminal, and dispatches the repair via `buildHubRepairInput`.

## Part A — Review (write findings, don't fix unless trivial+obviously-correct)
Read the diff (`git show fb49a91`) and the surrounding functions. Assess specifically:
1. **Correctness of the park→repair→fresh-rerun state machine.** Can the parent get stuck parked
   forever if the repair child is lost/orphaned (e.g. runner dies)? Is there a backstop?
2. **Idempotency / double-dispatch.** Two reconcile ticks, or a completion hook racing the reaper
   — can the parent be re-run twice, or the repair child dispatched twice? Show the guard.
3. **Cap/loop-breaker.** Does the per-fingerprint repair cap actually prevent infinite
   repair→rerun→fail→repair loops? What happens at the cap?
4. **Safety.** Confirm the repair child truly cannot push to `main` or land on a production runner.
   Check `buildHubRepairInput` routing inheritance + branch forcing for real, incl. the case where
   the failed run had NO explicit runnerLocation.
5. **Fresh re-run integrity.** Does dropping `__resume` actually yield a clean run, and is prior
   run state (attempt counters, lineage) preserved correctly across the fresh re-run?
Record a clear verdict per item: sound / risky / broken, with file:line evidence.

## Part B — Live proof (the real thing)
1. Back up the live DB first (additive). Never touch the 2 production runners (cap4/cap2).
2. Canary capability + throwaway local-origin repo, ONE deterministic JS bug, one-line fix
   (reuse `/home/xiko/canary-repair-proof` if present). Throwaway tagged runner only.
3. Enable `HUB_SUPERVISOR_REPAIR_ENABLED=true` for THIS test's hub only — do NOT leave the
   production hub flag on; it is currently OFF and must stay OFF until the operator re-enables it.
4. Prove from hub events + DB: classify code bug → parent parked → repair child created on
   `smithers-self-repair` branch → **Codex actually edits the canary source** (show diff) →
   repair child terminal → parent **re-runs FRESH (new smithers run id, not a resume)** →
   `succeeded` → per-fingerprint counter bumped → second identical failure at cap → **escalates**
   (operator card, no infinite loop) → no leaked runner slots.
5. Clean up the canary + throwaway runner.

## Gates
- Live cycle MUST reach `succeeded` via fresh re-run. If not, say so with evidence; recommend the
  flag stay OFF. No faked pass.
- Re-run full suite at end: `node --experimental-sqlite --test tests/*.test.js` (expect 432/432).
- Do NOT push commits. Do NOT enable the flag on the production hub. Do NOT touch prod runners.

## Deliverable
Write `/home/xiko/clawd/logs/runyard-phase2-codex-review.md` with: Part A verdict per item
(with file:line), Part B event timeline + Codex repair diff + proof of fresh-rerun→succeeded +
cap escalation + slot check, full-suite result, and a final one-line **SHIP / DON'T SHIP**
recommendation for enabling the flag. Be honest — if you'd not ship it, say why.
