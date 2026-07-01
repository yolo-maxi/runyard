# Claude Goal: ElectricSQL Query-Layer Replacement + Streaming CLI Trace Demo

You are working in a separate RunYard worktree:

- repo worktree: `/home/xiko/runyard-worktrees/electric-sql-traces`
- branch: `feature/electric-sql-traces-demo`
- base: current `origin/main`

Fran wants a bold prototype/demo by tomorrow:

> Explore using ElectricSQL instead of the current querying layer. The objective of ElectricSQL would be to fully replace the existing querying layer, not add a timid sidecar. Ideally also show streaming CLI traces in the UI. Put it on a parallel subdomain for Fran to try.

## Current Context

Main RunYard is a live system. Another Codex tmux session is currently rearchitecting runner reliability in the main worktree. Do not touch `/home/xiko/runyard` except for read-only comparison if absolutely needed. Do all implementation in this worktree.

RunYard currently uses local SQLite plus API polling/query endpoints for Hub data. This goal is about proving a replacement path where the UI gets live/reactive data through an Electric-style sync/query layer, with streaming agent/CLI traces visible instead of blank/stale UI while work runs.

## ElectricSQL Documentation Pointers

Use current official docs as source material:

- https://electric-sql.com/docs/guides/shapes
- https://electric-sql.com/docs/api/clients/typescript
- https://electric-sql.com/docs/api/http
- https://electric-sql.com/docs/guides/client-development
- https://electric-sql.com/docs/guides/postgres-permissions
- https://electric-sql.com/AGENTS.md

Important current-shape constraints to account for:

- Electric syncs Postgres data to clients through HTTP Shape logs.
- Shapes are the core primitive and are currently single-table; related data normally means multiple shapes and client joins/materialization.
- Production apps should proxy Electric requests through the backend for auth/authorization.
- Electric is primarily a Postgres sync engine, so a full replacement plan must address RunYard's current SQLite persistence and migration/projection strategy.
- Electric live mode uses HTTP long polling rather than WebSockets.

## Objectives

1. Understand the current RunYard querying layer:
   - DB/store modules
   - API read routes
   - frontend query collections/hooks
   - run event/log/trace surfaces
   - where polling or stale/blank states happen

2. Produce a serious ElectricSQL replacement architecture:
   - Not a sidecar sprinkled onto one page.
   - Define how Runs, Run Events, Runners, Artifacts, Approvals, Capabilities, and CLI trace chunks would be represented as syncable tables/shapes.
   - Define how SQLite data would migrate, mirror, or be replaced by Postgres.
   - Define backend auth proxy shape endpoints.
   - Define how writes/mutations remain safe and server-authoritative.
   - Define fallback behavior if Electric is down.

3. Build a working demo path:
   - Prefer a real runnable prototype in this branch over a pure spec.
   - At minimum, wire one meaningful live UI surface end-to-end:
     - Runs list and/or run detail should react from live synced data, OR
     - CLI trace stream should visibly update in UI as events/log chunks arrive.
   - The demo should make CLI/agent trace progress visible while a workflow runs, so the UI is no longer blank during long tasks.

4. Deploy to a parallel protected subdomain:
   - Use a separate service/subdomain from production RunYard, e.g. `runyard-electric.repo.box` unless a better name is already configured.
   - Before choosing a port, read `/home/xiko/clawd/PORT-REGISTRY.md` and claim/use an appropriate free port.
   - Do not build, test, install, or run agent workloads on repo.box. Build and run on Hetzner unless Fran explicitly says otherwise.
   - Protect the demo with auth/magic-link/token by default. Do not expose an unauthenticated admin/control-plane UI.
   - Verify the Caddy route explicitly before reporting the URL.

## Implementation Guidance

Make bold decisions, but keep the demo honest:

- If ElectricSQL cannot fully replace the querying layer quickly because of the SQLite/Postgres gap, build the strongest vertical slice and document the migration plan/blockers precisely.
- Avoid half-hidden duplicate data paths. If the demo still uses existing APIs for part of the flow, say exactly where and why.
- Prefer deterministic scripts/adapters over hand-maintained sync glue.
- Keep UI copy/control surfaces concise and operator-focused.
- Do not break or deploy over the live production `runyard.repo.box` service.

## Verification Gates

Run the relevant gates and keep fixing until clean or blocked with evidence:

- focused tests for new sync/projection/trace modules
- `pnpm test`
- `pnpm build`
- `git diff --check`
- live demo smoke:
  - health endpoint for demo service
  - protected subdomain returns auth challenge or token flow
  - app bundle/UI loads
  - live trace/sync surface visibly updates or has deterministic smoke evidence

## Completion Requirements

- Commit the work on `feature/electric-sql-traces-demo`.
- Push the branch to origin.
- Deploy the demo to the parallel protected subdomain if feasible.
- Update `/home/xiko/clawd/memory/projects/smithers-hub.md` with:
  - branch/commit
  - architecture decision
  - demo URL/auth details if deployed
  - tests/smokes
  - blockers/caveats
- Leave the worktree clean.
- Report back with:
  - branch and commit
  - demo URL
  - what is actually Electric-backed / live-streaming
  - what remains to fully replace the querying layer
  - exact verification evidence
