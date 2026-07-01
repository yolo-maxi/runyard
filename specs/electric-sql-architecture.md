# RunYard × ElectricSQL — Query-Layer Replacement + Live CLI Traces

Status: **working demo** on `feature/electric-sql-traces-demo`, deployed to
`https://runyard-electric.repo.box` (Hetzner, protected).

## Objective

Replace RunYard's client **read/query layer** — REST polling + SSE — with
ElectricSQL shape streaming, and make CLI/agent traces stream live into the UI
instead of the UI sitting blank/stale while a run executes.

## Decision (what "full replacement" means here, honestly)

RunYard persists to **SQLite** (`node:sqlite`), and its live system is running in
production. Electric is a **Postgres** sync engine. A safe one-day replacement of
the *query layer* — without a risky migration of live data — is:

- **SQLite stays the system of record.** All writes keep going through the
  existing authenticated REST endpoints (server-authoritative). Electric is
  strictly **read-only** to clients; it never accepts writes.
- **A deterministic projector mirrors SQLite → Postgres** (`src/electric/projector.js`).
  Postgres is a projection/replica used solely as Electric's source.
- **Electric syncs Postgres → clients** as HTTP shape logs.
- **The entire client read path becomes Electric shapes.** The TanStack DB
  collections that used to poll REST now stream from Electric; the per-run trace
  console that used SSE now streams from an Electric `run_events` shape.

This replaces the query layer wholesale on the client, while treating the
SQLite→Postgres projection as the migration bridge. The end-state (Postgres as
primary store, SQLite retired) is described under **Migration path**; the
projector proves the sync path end-to-end without touching the live DB.

## Entities → shapes

Electric shapes are single-table. RunYard's read entities map to one shape each,
mirrored into Postgres (`electric/pg-schema.sql`) and exposed through the auth
proxy under fixed shape names:

| Shape | Postgres table | Client collection | Notes |
|------|----------------|-------------------|-------|
| `runs` | `runs` | `runsCollection` | Runs list + run detail header |
| `run_events` | `run_events` | per-run events collection | **Live CLI/agent trace**, filtered by `run_id` |
| `runners` | `runners` | `runnersCollection` | Fleet view, sidebar badges |
| `capabilities` | `capabilities` | `capabilitiesCollection` | Catalog |
| `approvals` | `approvals` | `approvalsCollection` | Approvals view + badges |
| `artifacts` | `artifacts` | (available) | Per-run artifacts |

Timestamps are stored as verbatim ISO-8601 text (lossless); JSON columns as
`jsonb`. The browser normalizers (`web/lib/electricNormalize.js`) convert the
snake_case, string-typed shape rows into the exact camelCase objects the existing
views already expect from REST, so views are byte-compatible on either path.

## SQLite → Postgres projection

`src/electric/projector.js`, decoupled sync glue that only reads SQLite and
writes Postgres (so it can never corrupt the source of truth):

- **Small mutable tables** (`runs`, `runners`, `capabilities`, `approvals`,
  `artifacts`): full mirror per tick — upsert all rows + delete rows no longer
  present. Handles inserts, updates and deletes with trivial cost at demo scale.
- **`run_events`** (immutable, append-only, high-volume trace): incremental
  append keyed on the SQLite **rowid**, a stable monotonic per-insert cursor.
- Default tick 500 ms. End-to-end latency = projector tick + Electric long-poll,
  which reads as live in the UI (sub-second). The pure SQL builder is unit-tested
  (`src/electric/upsertSql.js`, `tests/electric-upsert-sql.test.js`).

## Backend auth proxy

`src/electric/electricProxy.js` mounts `GET /api/electric/v1/shape` behind
RunYard's existing `requireAuth` (session cookie or Bearer token). It:

- restricts shapes to a fixed **allowlist** of mirror tables (no arbitrary SQL/tables);
- scopes the `run_events` trace stream to a **validated `run_id`** (server-defined
  `where`; clients cannot supply filters);
- forwards only the Electric protocol params (`offset`, `handle`, `live`,
  `cursor`, `replica`, `columns`) and relays the `electric-*` response headers so
  the client can page and go live;
- aborts the upstream long-poll when the client disconnects.

The **Electric sync service is bound to localhost** (`127.0.0.1:3316`) and never
routed publicly — clients only ever reach it through this authenticated proxy,
matching Electric's production guidance. `GET /api/electric/status` exposes sync
health + projector stats for smoke checks.

## Server-authoritative writes

Unchanged. Mutations still go through the existing REST endpoints
(`POST /api/runs/:id/*`, approvals, etc.) with their scopes and ownership checks.
Electric/the proxy are read-only. After a write lands in SQLite, the projector
mirrors it (≤ tick) and Electric streams it to every subscribed client — no
client-side cache invalidation needed.

## Fallback behavior (if Electric is down)

Two layers, so the UI always works:

1. **Runtime toggle** (`web/lib/electricConfig.js`): Electric is the default; set
   `localStorage["runyard.electric"]="off"` (or `window.__RUNYARD_DISABLE_ELECTRIC__`)
   to use the original REST polling collections unchanged.
2. **Automatic degrade**: each Electric collection watches for hard stream
   failures (proxy/sync down) and transparently falls back to polling the legacy
   REST endpoint (`electricCollection.js`); the run-events collection falls back
   to the original SSE + 3s poll. `useLiveQuery` consumers need no changes.

## Deploy topology

```
browser ──HTTPS──> Caddy (runyard-electric.repo.box)
                     └─> RunYard demo hub  127.0.0.1:3118  (systemd: runyard-electric.service)
                          ├─ existing REST API + SPA (auth: token login)
                          ├─ /api/electric/v1/shape  (auth proxy) ──> Electric 127.0.0.1:3316
                          └─ projector: SQLite (data-demo/) ──> Postgres 127.0.0.1:54329
   Postgres + Electric: docker compose (electric/docker-compose.yml), localhost-only
```

Isolated from production: separate port, separate data dir, separate Postgres,
separate systemd unit. Production `runyard.repo.box` (127.0.0.1:43117) untouched.

## What is actually Electric-backed / live today

- Runs list, runners, capabilities, approvals collections stream from Electric shapes.
- The per-run CLI/agent **trace console streams live** from a `run_events` shape
  scoped to that run — verified: new `smithers.dispatched → agent.thinking →
  tool.shell` events arrive over Electric long-poll while a run executes.
- A topbar **⚡ Electric** chip shows sync status + events mirrored.

## What remains to fully replace the query layer

- **Postgres-primary cutover.** Today SQLite is SoR + projector. Full replacement
  = write directly to Postgres (or logical-replicate SQLite → PG once), retire the
  projector, and point RunYard's stores at PG. This is the documented next step;
  the projector de-risks it by proving the sync/shape path first.
- **Remaining REST reads not yet migrated**: the Home `/api/dashboard` aggregate,
  run detail's one-shot `/api/runs/:id` payload (events now live via shape), and
  artifact downloads (binary, stays REST). These are additive follow-ups.
- **Shape-level authorization** beyond per-run scoping (e.g. row filtering by
  tenant) if RunYard becomes multi-tenant.

## Verification

- `pnpm test` → 1078/1078 pass (incl. 16 new: upsert SQL, shape protocol, normalizers).
- `pnpm build` → clean. `git diff --check` → clean.
- Live smoke (`scripts/smoke-electric.mjs`) against the public URL: health +
  status, 401 on unauthenticated shapes, runs shape synced + streaming live change
  ops, run_events shape synced per run.
