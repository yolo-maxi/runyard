# PGlite Migration Evaluation (follow-up)

Fran's ask: *"evaluate PGLite migration instead of whatever a projection is."* He
dislikes the "projector" framing. This evaluates PGlite as the migration target
for the ElectricSQL branch and gives a clear recommendation.

## TL;DR / recommendation

**PGlite does not replace the projector's job, because Electric cannot sync *from*
PGlite.** Electric's sync service consumes a **Postgres logical-replication stream
over a `DATABASE_URL`**; PGlite is an *embedded, single-connection* library with
no wire-protocol server and no logical-replication source. So "make PGlite the
server DB and let Electric read it directly" is blocked today — you'd still need a
real Postgres between PGlite and Electric, i.e. a projector by another name.

The framing Fran wants ("stop talking about a projector") is right — but the fix
is **Postgres-as-primary**, not PGlite:

1. **End state:** the demo hub writes directly to a **real Postgres**; Electric
   reads that Postgres directly. No projector, no SQLite. This is the honest
   "full replacement," and it's a small step from where the branch already is.
2. **PGlite's genuinely useful role** (and where it *is* better than a projector):
   the **in-process, Docker-free Postgres used to migrate and test** RunYard's
   schema + queries off SQLite — and, optionally later, a browser-side cache.
   This is now demonstrated by a passing test (`tests/pglite-schema.test.js`):
   PGlite hosts the exact mirror schema and runs the projector's generated SQL
   under real Postgres semantics (jsonb, bigint, `ON CONFLICT`).

So: **PGlite is not a better *migration target* than a real Postgres, but it is a
better *migration tool* than a hand-run Docker Postgres.** Use it to port and
verify; ship real Postgres as the primary.

## The decisive constraint

Electric ("Postgres Sync") "connects to your Postgres using a `DATABASE_URL`,
consumes the logical replication stream and fans out data into Shapes." That
requires `wal_level=logical`, replication slots, and a reachable Postgres
endpoint (exactly what `electric/docker-compose.yml` sets up).

PGlite, per its own docs, "only has a single exclusive connection to the
database," is an embedded library (no server / wire protocol), and its docs
contain **no mention of acting as a logical-replication source**. The
`@electric-sql/pglite-sync` plugin syncs **into** PGlite and is one-way:
> "We don't yet support local writes being synced out, or conflict resolution."
It is **alpha/beta**, cannot sync multiple shapes into one table, and buffers
large initial syncs in memory.

Therefore PGlite is a **sync destination**, never an Electric **source**.

## Three migration shapes, compared honestly

| | 1. Projector (current demo) | 2. Server-side PGlite primary | 3. Browser PGlite cache |
|---|---|---|---|
| SoR | SQLite | PGlite (Node, FS-persisted) | server DB (unchanged) |
| How Electric gets data | SQLite→Postgres projector, Electric reads Postgres | **Blocked** — Electric can't read PGlite; still needs PGlite→Postgres replication | Electric reads server Postgres |
| Removes the projector? | no | **no** (still need PGlite→PG for Electric) | n/a (server side unchanged) |
| Client read path | Electric shape collections | Electric shape collections | shapes synced into PGlite + live queries |
| Fixes SQLite↔PG dialect gap | no (two dialects) | **yes** (one dialect: Postgres) | n/a |
| New risk | bespoke sync glue | alpha WASM DB as prod SoR: single connection, immature durability/backup, WASM perf | +~3MB WASM bundle, alpha one-way plugin, offline-first scope creep |
| Status | **working, deployed** | prototype-only | prototype-only |

### Option 1 — projector (what's deployed)
Reversible bridge: SQLite stays SoR, mirror to Postgres, Electric streams. Proves
the whole client read path with zero risk to the live DB. Downside is exactly
what Fran named: "projector" is bespoke glue and reads like a permanent design
when it's meant to be a stepping stone.

### Option 2 — server-side PGlite primary
Attractive because it collapses the two-dialect problem: replace `node:sqlite`
with PGlite and the schema/types/queries become genuinely Postgres (jsonb,
timestamptz, `ON CONFLICT`, `RETURNING`). **But it does not remove the projector
from the *sync path*** — Electric still needs a real Postgres source, so you'd
run PGlite→Postgres replication anyway. And betting a *live control plane's*
storage on an alpha, single-connection WASM Postgres (immature durability/backup
story, no concurrent connections, WASM performance) is a poor trade for a
production system. Net: real cost, and it doesn't even delete the projector.

### Option 3 — browser PGlite cache
Sync Electric shapes into browser PGlite and query with live queries. This is
PGlite's headline use case, but for RunYard's *online* Hub it adds a ~3MB WASM
payload and an alpha, one-way plugin to get reactivity we already have: the branch
already delivers reactive `useLiveQuery` collections straight off Electric shapes
with **no** extra browser dependency. Browser PGlite only pays off for
offline-first authoring — which Fran explicitly flagged as out of scope ("replace
the query layer, not offline-first authoring").

## What exactly blocks PGlite-as-source today

- No Postgres wire-protocol server / no listener Electric can dial.
- No logical-replication source (no replication slots / publication exposed).
- Single exclusive connection — incompatible with Electric holding a replication
  connection alongside the app's own connection.
- The only Electric↔PGlite integration that exists is **inbound** shape sync
  (alpha, one-way).

None of these are things we can patch in this repo; they're upstream properties
of PGlite. So PGlite-as-Electric-source is not "hard," it's "not a feature."

## Credible next prototype (recommended)

**Postgres-primary hub, no projector, PGlite as the migration harness:**

1. Point the hub's data layer at Postgres. Port `src/dbSchema.js` +
   `node:sqlite` calls to Postgres SQL. **Develop and test this against PGlite**
   in-process (Docker-free CI; `tests/pglite-schema.test.js` is the seed of this
   harness), then run the same SQL against the real Postgres in prod.
2. Delete the projector; Electric reads the hub's Postgres directly. The auth
   proxy, shape allowlist, per-run trace scoping, and the frontend shape client
   all stay exactly as-is — they don't care whether Postgres is fed by a
   projector or is the primary.
3. Migrate the existing SQLite data once (a one-shot `sqlite→pg` copy, not an
   ongoing projector), or start clean for the demo.

This keeps every client-facing gain of the current branch while removing the
framing Fran dislikes, and uses PGlite where it's actually strong.

## What should happen to the existing Electric demo branch

Keep it. It already proves the hard part — the **client read path is fully
Electric-backed and CLI traces stream live**. Reframe the projector in the docs as
an explicitly *reversible migration bridge*, not the destination (done in
`specs/electric-sql-architecture.md`). The Postgres-primary cutover is a
follow-up PR; this branch is the de-risking prototype plus this evaluation.

## Evidence

- `tests/pglite-schema.test.js` (3/3): PGlite loads `electric/pg-schema.sql`,
  runs `buildMultiUpsert` insert+`ON CONFLICT` update with a `::jsonb` cast, and
  round-trips bigint pk + jsonb — i.e. the mirror schema and projector SQL are
  Postgres-correct, validated in-process without Docker.

## Sources

- Electric HTTP/Postgres Sync (logical replication over `DATABASE_URL`): https://electric.ax/sync/postgres-sync , https://electric.ax/sync/pglite
- PGlite docs (single connection, embedded, live queries, persistence): https://pglite.dev/docs/
- PGlite sync (one-way, alpha, no local writes out / no conflict resolution): https://pglite.dev/docs/sync
- `@electric-sql/pglite-sync`: https://www.npmjs.com/package/@electric-sql/pglite-sync
