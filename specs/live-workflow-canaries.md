# Live Workflow Canaries

Log of live canary validations for RunYard's isolated workflow +
promote-to-main release path. Each entry is a lightweight, docs-only
change exercised end-to-end through the gated pipeline (isolated
worktree → workflow branch → promotion to `main`) before a release.

## Entries

### 2026-07-01 — Isolated workflow promotion validated
- Ran a harmless docs-only change through the isolated workflow branch
  and the promote-to-main path to confirm the release pipeline is green
  before shipping.
- Verified `git diff --check` clean; no code paths touched, so heavy
  tests and build were intentionally skipped per the change request.
- Scope: this file only. Purpose: canary signal that isolated
  workflow → main promotion works before release.
