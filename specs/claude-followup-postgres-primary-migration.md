# Follow-Up: Make Real PostgreSQL The Target + Prepare SQLite Migration

New instruction from Fran:

> Ok fine then. Integrate into a real PostgreSQL. Prep migration scripts to move existing data.

Do not open the PR yet. Extend the current ElectricSQL branch so the next step is a real Postgres-primary migration, not an ongoing SQLite→Postgres projector design.

## Current branch context

- Worktree: `/home/xiko/runyard-worktrees/electric-sql-traces`
- Branch: `feature/electric-sql-traces-demo`
- Current pushed follow-up: `45981f1 docs(electric): evaluate PGlite migration; reframe projector as reversible bridge to Postgres-primary`
- Demo already has Postgres schema in `electric/pg-schema.sql`, an Electric proxy, frontend Electric shape collections, live CLI traces, and a demo SQLite→Postgres projector.
- PGlite evaluation concluded that real Postgres is the actual Electric source target.

## Objective

Move the branch toward a real Postgres-primary RunYard:

1. Add concrete migration scripts/tools to move existing RunYard SQLite data into Postgres.
2. Make the Postgres schema and data conversion explicit, repeatable, and testable.
3. Keep the current demo working, but reframe the projector as temporary migration/demo glue only.
4. If feasible in this pass, add a server config mode or storage abstraction that can read/write against Postgres directly for at least the core tables. If full store cutover is too large, produce the strongest migration tooling and a precise cutover plan.

## Required migration coverage

Cover at least these existing RunYard entities:

- `runs`
- `run_events`
- `runners`
- `capabilities`
- `approvals`
- `artifacts`
- relevant auxiliary tables if present and needed for UI correctness

Migration requirements:

- one-shot SQLite → Postgres copy script, not an ongoing projector
- idempotent or safely re-runnable where practical
- preserves primary keys, timestamps, JSON payloads, statuses, runner IDs, parent/run lineage fields
- validates row counts and important referential links after copy
- supports dry-run / plan mode
- documents rollback/backup expectations
- never prints secrets or token material

## Implementation preferences

- Prefer deterministic Node scripts under `scripts/` and testable modules under `src/electric/` or a better local namespace.
- Reuse `electric/pg-schema.sql` if correct; fix it if incomplete.
- Add tests that migrate from an in-memory/temp SQLite fixture to a Postgres-compatible target. PGlite can be used as the test harness if useful.
- If introducing production Postgres env vars, document them clearly and keep defaults safe.
- Do not deploy over production `runyard.repo.box`.
- Keep demo subdomain auth/protection intact.

## Verification

Run:

- focused migration tests
- `pnpm test`
- `pnpm build`
- `git diff --check`
- if demo service changes, run the Electric smoke test again

## Completion

- Commit and push the Postgres-primary migration follow-up on `feature/electric-sql-traces-demo`.
- Update `specs/electric-sql-architecture.md` and/or add a migration spec so the architecture no longer sounds like the projector is the desired final design.
- Update `/home/xiko/clawd/memory/projects/smithers-hub.md` with the branch/commit, migration scripts, gates, and caveats.
- Report concise output: what migration scripts exist, what they cover, gates, and what remains before production cutover.
