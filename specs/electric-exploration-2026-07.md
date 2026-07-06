# ElectricSQL for RunYard — fresh exploration (July 2026)

Status: exploration on `runyard/electric-explore`, grounded in current `main`
(post supervisor-retirement, post hooks/lockdown/ask-contract). The June demo
branch (`feature/electric-sql-traces-demo`) is deleted; its tip is preserved as
tag `archive/electric-sql-traces-demo` and its four specs are recovered into
`specs/` here (`electric-sql-architecture.md`, `pglite-migration-evaluation.md`,
`postgres-primary-migration.md`, `claude-goal-electric-sql-traces.md`).

## The two goals

1. **More efficient frontend** — stop the poll storm, make every view live.
2. **Streamed terminal results** — CLI/agent traces render as they happen.

## What main does today (measured)

- `web/lib/collections.js`: TanStack DB collections backed by REST polling —
  `/api/runs?limit=200` every **4 s** while any run is active (30 s idle),
  approvals/runners every 30 s, capabilities every 60 s. Average run row is
  ~2.8 KB, so the runs poll alone is ~550 KB per tick per open tab while
  anything runs.
- `web/lib/runEventsCollection.js`: the per-run console already streams via
  **SSE** (`GET /api/runs/:id/events/stream` off `src/runEventBus.js`) with a
  3 s poll fallback. So *per-run* terminal streaming exists on main; what is
  NOT live is everything else — runs list, dashboard, approvals badges,
  runners fleet.
- Scale pressure is real: `run_events` holds **1.28 M rows / ~1.16 GB of
  message text** (worst single runs ~150 k events), DB 1.7 GB, disk 88 % full.
  Any plan that mirrors or replicates `run_events` must budget for that.

## What the June demo already proved (do not re-derive)

The archived demo was a **working deployment**, not a sketch:

- SQLite stayed source of truth; a 500 ms-tick projector mirrored six tables
  into Postgres; Electric streamed shapes to the browser through an
  authenticated proxy (`/api/electric/v1/shape`, allowlisted tables, server-set
  `where run_id=...`, Electric bound to localhost).
- Client collections swapped to shape streaming with **byte-compatible row
  normalization**, a runtime kill-switch, and automatic degrade back to
  REST/SSE. Live run traces over Electric long-poll were verified end-to-end.
- One-shot SQLite→Postgres migration tooling (`migrate.js`, plan/apply/validate)
  was validated against real data.
- PGlite was evaluated and rejected as an Electric source (Electric needs real
  Postgres logical replication); PGlite's niche is schema/query testing.

Conclusion carried over: the projector is a **bridge to prove the path**, not a
thing to operate forever. The honest end-state is **Postgres-primary** with
Electric reading it directly, and that means swapping the hub's synchronous
`node:sqlite` store layer for async `pg` — a large, invasive change.

## The real decision (product, not tech)

RunYard's install story today is *"node + SQLite, zero external services"*
(`install.sh`, self-hosted control plane). Electric-as-shipped adds **two
containers (Postgres + Electric) and a projector** to that story; Electric
as end-state replaces SQLite entirely. Both are defensible — but it's a
product-surface decision (same class as the catalog-tiers/trust-boundary calls
in `product-surface-audit.md`), not a frontend refactor.

So: **is the idea reasonable? Yes — the demo proved it works and feels
dramatically better. But it is not the cheapest path to either stated goal.**

## Recommendation — three phases, each independently shippable

### Phase 1 (days, no new infra): hub-wide SSE invalidation bus
`runEventBus` already exists and the reaper/schedulers already emit
`run.created/assigned/failed/...` events. Add one endpoint,
`GET /api/events/stream` (auth-gated, coarse events: entity + id + kind, no
payloads), and have the TanStack collections **refetch on signal instead of on
a 4 s timer** (keep a slow 60 s safety poll). This kills ~95 % of poll traffic,
makes the runs list/badges effectively live, and touches ~2 files per side.
Per-run terminal streaming already works via SSE today.

### Phase 2 (only if/when Postgres-primary is decided): migrate the store
Use the validated `migrate.js` tooling and the runbook in
`postgres-primary-migration.md`. Do it for hub reasons (concurrency, FKs,
retention/partitioning of `run_events`, backups), not for Electric per se.
Prerequisite hygiene either way: event retention/compaction — 1.16 GB of
terminal text in the DB is a problem on every path.

### Phase 3 (after Postgres-primary): Electric read layer, no projector
Resurrect the demo's client work — shape collections, normalizers, auth proxy,
status chip (all recoverable from `archive/electric-sql-traces-demo`) — pointed
at the primary Postgres. Skip the projector entirely; that was scaffolding.
This is when the frontend becomes fully shape-streamed with resumable offsets,
and multi-tab/multi-user cost stops scaling with poll frequency.

### What I would not do
- Ship the projector topology (SQLite + mirror Postgres + Electric + fallback
  dual read paths) to production. Four moving parts and a dual code path to
  maintain, for a UX win Phase 1 gets ~80 % of at ~5 % of the cost.
- Start the `node:sqlite`→`pg` swap casually. It converts a synchronous store
  API to async across the whole hub; schedule it as its own release train.

## Open questions for Ocean
1. Is Postgres-primary an acceptable end-state for the self-hosted install
   story (docker/managed-pg requirement), or must SQLite-only stay a supported
   tier forever? (If the latter: Phase 1 is the permanent answer, Electric
   stays a scale-tier option.)
2. Retention policy for `run_events` — cap per run? age out? artifact-ize full
   logs and keep only the tail queryable?
3. Does the workflow-package work in flight (`src/workflowPackage*.js`) change
   what the catalog views need from the read layer before Phase 1 lands?
