# Follow-Up: Evaluate PGlite Migration Instead Of SQLite→Postgres Projection

New instruction from Fran:

> Please evaluate PGLite migration instead of whatever a projection is.

Stop before opening a PR. Re-evaluate the ElectricSQL branch with PGlite as the primary migration idea.

## Current branch context

- Worktree: `/home/xiko/runyard-worktrees/electric-sql-traces`
- Branch: `feature/electric-sql-traces-demo`
- Current commit: `9962410 feat(electric): replace client query layer with ElectricSQL shape streaming + live CLI traces`
- Existing demo uses SQLite as source of record plus a SQLite→Postgres projector feeding Electric.
- Fran dislikes the projector framing. He wants a clearer PGlite migration evaluation.

## Current PGlite/Electric facts to consider

Use official docs:

- https://pglite.dev/docs/
- https://pglite.dev/docs/sync
- https://electric.ax/sync/pglite
- https://github.com/electric-sql/pglite

Facts from current docs:

- PGlite is a lightweight WASM Postgres build packaged for TypeScript.
- It runs in browser, Node.js, Bun, and Deno.
- It can persist to native filesystem in Node/Bun/Deno or IndexedDB in the browser.
- It has reactive/live-query primitives.
- Electric's PGlite sync plugin can sync Electric shapes **into** PGlite tables.
- The PGlite sync plugin is currently alpha and does not yet support local writes being synced out or conflict resolution.

## What to evaluate

Compare three migration shapes honestly:

1. **Current demo projector**
   - SQLite remains system of record.
   - Project SQLite→Postgres.
   - Electric streams Postgres shapes to clients.

2. **Server-side PGlite primary**
   - Replace `node:sqlite` storage with PGlite running in Node/Bun with filesystem persistence.
   - Keep server-authoritative writes, but write to Postgres-compatible PGlite SQL instead of SQLite.
   - Evaluate whether Electric can stream directly from PGlite or whether a real Postgres/Electric source is still needed.
   - Evaluate operational risks: single-process WASM DB, durability, backups, concurrent access, observability, migrations, performance, and compatibility with current SQLite idioms.

3. **Browser/client PGlite cache**
   - Keep a server DB as authoritative.
   - Sync Electric shapes into browser PGlite and query locally with live queries.
   - Evaluate whether this is better than direct Electric shape collections for RunYard's Hub UI.
   - Watch for scope creep: Fran asked for replacing the query layer, not offline-first authoring.

## Desired output

Update `specs/electric-sql-architecture.md` or add a focused `specs/pglite-migration-evaluation.md` with a clear recommendation:

- Is PGlite a better migration target than the current projector?
- If yes, what should the architecture become?
- If no, what exactly blocks it today?
- What would a credible next prototype look like?
- What should happen to the existing Electric demo branch?

If a small code change makes the demo more PGlite-aligned without blowing up the schedule, implement it. Otherwise keep code stable and produce the strongest technical evaluation.

## Verification

Run at least:

- focused tests affected by any changes
- `pnpm test`
- `pnpm build`
- `git diff --check`

Then commit and push the follow-up on `feature/electric-sql-traces-demo`.

Do not open the PR until this PGlite evaluation is included.
