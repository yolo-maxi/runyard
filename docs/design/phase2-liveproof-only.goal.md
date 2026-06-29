# GOAL: Live end-to-end proof of the FIXED Phase-2 hub repair (proof only — impl already committed)

Working dir: `/home/xiko/runyard` (Hetzner, single box). The Phase-2 substrate fix is ALREADY
IMPLEMENTED and COMMITTED at `fb49a91` (full suite 432/432 green). Do NOT re-implement it. Your
ONLY job is the live end-to-end proof with real Codex, then a short report. Be economical with
context — you do not need to re-read the whole codebase; the design is settled.

## The fix you are proving (already in the code):
- `buildHubRepairInput()` (src/hubSupervisor.js): repair child runs on a dedicated branch
  (`smithers-self-repair`, NEVER main), inherits the failed run's runner routing, scopes repo.
- `requeueRunFresh` + `reconcileRepairChildTerminal` (src/db.js, wired in src/server.js): the
  failed parent is PARKED (`awaitingRepair`) while the one-shot repair child runs; on repair
  success the parent RE-RUNS FRESH (drops `__resume`), on failure it escalates. Idempotent.

## The proof (the part the previous run crashed before reaching):
1. Back up the live DB first (`data/runyard.sqlite` or `data/smithers-hub.sqlite`) — additive only.
2. Build an isolated **canary capability** + throwaway local-origin repo with ONE deterministic
   JS bug whose fix is a one-line edit (reuse the prior canary at `/home/xiko/canary-repair-proof`
   if it still exists).
3. Start a **throwaway runner** (tagged, never the 2 production runners cap4/cap2 — see the
   runner-id gotcha in memory: ad-hoc runners need an explicit stable id + tag routing).
4. Set `HUB_SUPERVISOR_REPAIR_ENABLED=true` for THIS test only (your own test hub/env — do NOT
   leave the production hub's flag on; it is currently OFF and must stay OFF until I verify).
5. Dispatch the canary through the hub and prove from hub events + DB:
   - classify → deterministic code bug,
   - parent parked (`awaitingRepair`), repair child created on `smithers-self-repair` branch,
   - **Codex actually edits the canary source** (show the diff),
   - repair child terminal → parent **re-runs FRESH** (new smithers run id, NOT a resume) →
     reaches `succeeded`,
   - per-fingerprint repair counter bumped; a second identical failure with the cap spent
     **escalates to an operator card** (no infinite loop),
   - no leaked runner slots after the cycle.
6. Clean up: remove the canary capability + throwaway runner. Leave production runners untouched.

## Gates
- The live cycle must actually reach `succeeded` via fresh re-run (not resume). If it does NOT,
  say so plainly with evidence and recommend whether the flag should stay OFF. No faked pass.
- Re-run the full suite once at the end: `node --experimental-sqlite --test tests/*.test.js` (expect 432/432).
- Do NOT push commits. Do NOT enable the flag on the production hub. Do NOT touch prod runners.

## Deliverable
- Write `/home/xiko/clawd/logs/runyard-phase2-repair-proof.md`: event timeline w/ timestamps,
  the Codex repair diff, proof the parent re-ran fresh (new sid) and hit succeeded, the cap-hit
  escalation evidence, slot-leak check, and final gate/test results.
- If green, you may `git add` only NEW proof artifacts/docs and commit them locally (no push).

Stop when the proof is captured or you hit a real documented blocker.
