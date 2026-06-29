# GOAL: Prove Phase-2 hub-side code repair end-to-end, live, with Codex

Context: Working dir is `/home/xiko/runyard` (single box, Hetzner). The hub-as-supervisor
already resumes orphaned/failed runs (Phase 1, shipped + proven). Phase 2 — hub dispatches a
**Codex code-repair run** (`implement-change-gated`) when a supervised run fails with a
*deterministic workflow-code bug*, then resumes — was coded but gated OFF because on-box Codex
auth was expired.

Codex auth is now restored (`codex login status` → "Logged in using ChatGPT"). The flag
`HUB_SUPERVISOR_REPAIR_ENABLED=true` is now set in `/home/xiko/runyard/.env` and the hub
(`runyard.service`) has been restarted with it loaded. 21/21 repair unit tests pass.

Your job: prove the Phase-2 repair → resume cycle works **live with real Codex**, safely, then
report. Do NOT touch the two production runners' config or production workflow source.

## Required gates (must all pass before you report DONE)
1. **Full suite green** with the flag on: `HUB_SUPERVISOR_REPAIR_ENABLED=true node --experimental-sqlite --test tests/*.test.js` — all pass, no regressions to today's earlier fixes.
2. **Live repair proof.** Construct an isolated **canary workflow** (a throwaway capability whose
   source has a single deterministic JS bug — e.g. a typo / undefined reference — so it fails the
   same way every run, and whose fix is a one-line edit). Dispatch it through the hub on a
   **throwaway runner** (never the two production runners). Confirm, from hub events + DB:
   - the hub classifies the failure as a deterministic workflow-code bug,
   - it emits `run.supervisor.repair_child` and creates an `implement-change-gated` repair run,
   - **Codex actually edits the canary source** (show the diff Codex made),
   - the original run **resumes and reaches `succeeded`**,
   - the per-fingerprint repair counter is bumped (cap = 1/fingerprint), and a second identical
     failure with the cap spent **escalates to an operator card** instead of looping.
   - no leaked runner slots after the cycle.
3. **No production impact.** Use throwaway runners/capabilities only. Back up the DB before any
   migration/dispatch. Confirm the two production runners (cap4 + cap2) stayed untouched and the
   hub is healthy at the end (`/healthz` 200, runners online).

## Cleanup
Remove the canary capability/workflow + throwaway runner when done so prod state is clean.
Leave `HUB_SUPERVISOR_REPAIR_ENABLED=true` in place (that's the point).

## Deliverable
- A short markdown report at `/home/xiko/clawd/logs/runyard-phase2-repair-proof.md` with: the
  exact event timeline (timestamps), the Codex repair diff, the escalation-on-cap-hit proof, and
  gate results.
- If anything is NOT solid (Codex flaky, repair doesn't converge, slot leak), say so plainly and
  recommend whether the flag should stay on or be reverted. Do not fake a pass.

Keep going until gates pass or you hit a real, documented blocker. Don't push commits.
