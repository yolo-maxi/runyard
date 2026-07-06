# Postgres-Primary Migration (SQLite → PostgreSQL)

Target architecture: **Postgres is the primary store** and Electric reads it
directly. The demo's SQLite→Postgres projector is temporary migration/demo glue,
not the destination. This doc covers the one-shot migration tooling that moves
existing RunYard SQLite data into PostgreSQL.

## Tooling

- **`src/electric/migrate.js`** — testable module: `introspectSqlite`,
  `buildCreateTable`, `planMigration`, `applyMigration`, `validateMigration`.
  Schema-driven (reads `PRAGMA table_info`), so it tracks the real schema instead
  of a hand-maintained column list. Works against any Postgres client exposing
  `query(text, values)` — node-postgres **or** PGlite (how the tests run).
- **`scripts/migrate-sqlite-to-postgres.mjs`** — CLI: `--plan` / `--apply` /
  `--validate` / `--emit-ddl`.

## What it covers

All non-sensitive SQLite tables, schema-driven. Verified on the live demo DB
(18 tables, 3.5k rows): `runs`, `run_events`, `runners`, `capabilities`,
`capability_versions`, `approvals`, `artifacts`, `run_lineage`, `agents`,
`skills`, `knowledge_resources`, `schedules`, `audit_log`, `workflow_endpoints`,
`workflow_endpoint_invocations`, `run_response_endpoints`, `settings`,
`_smithers_alerts`.

**Excluded by default (auth/secret material):** `secrets` (encrypted blobs) and
`access_tokens` (token hashes). Opt in with `--include-sensitive` only when the
target is trusted; these should normally be re-provisioned, not copied.

## Fidelity guarantees

- **Primary keys** preserved (single + composite, e.g. `settings.key`).
- **Timestamps** kept as verbatim ISO-8601 text (lossless; no tz reinterpretation).
- **JSON payloads** (`input`, `output`, `data`, `payload`, `metadata`, `tags`,
  capability schemas, …) converted from SQLite TEXT to real Postgres **`jsonb`**;
  malformed legacy JSON is coerced to `null` rather than aborting the run.
- **Statuses, runner ids, parent/lineage fields** (`runs.parent_run_id`,
  `run_lineage`, `capability_versions.capability_id`) copied and referentially
  validated.
- Numeric columns → `bigint`/`double precision`; BLOB → `bytea`.

## Safety & idempotency

- Source SQLite opened **read-only**; never modified.
- **Idempotent**: rows upsert on the primary key, so re-runs converge without
  duplicates (`--truncate` forces a clean reload instead).
- **Never prints row values or secrets** — only table names and counts.
- **`--plan`** is a dry run (no writes): shows tables, row counts, jsonb columns,
  and generated DDL.
- **`--validate`** checks row-count parity (SQLite vs Postgres) and referential
  orphans; exits non-zero on mismatch.

## Env vars

| Var | Purpose | Default |
|-----|---------|---------|
| `RUNYARD_HUB_DB` / `SMITHERS_HUB_DB` | source SQLite path | (or `--source`) |
| `MIGRATION_DATABASE_URL` | target Postgres | falls back to `DATABASE_URL` |
| `DATABASE_URL` | target Postgres | — |

No new production env vars are wired into the running service; the migration is an
operator-run script. Demo defaults stay localhost-only.

## Runbook

```bash
# 1. dry run — inspect what will move
node --experimental-sqlite scripts/migrate-sqlite-to-postgres.mjs --plan \
  --source /path/to/runyard.sqlite

# 2. back up the target first
pg_dump "$MIGRATION_DATABASE_URL" > backup-before-migrate.sql   # (or start empty)

# 3. copy
node --experimental-sqlite scripts/migrate-sqlite-to-postgres.mjs --apply \
  --source /path/to/runyard.sqlite --database-url "$MIGRATION_DATABASE_URL"

# 4. verify counts + referential integrity
node --experimental-sqlite scripts/migrate-sqlite-to-postgres.mjs --validate \
  --source /path/to/runyard.sqlite --database-url "$MIGRATION_DATABASE_URL"
```

**Rollback:** the source SQLite is untouched, so rollback = keep running the
SQLite hub (or `runyard.service`). The target Postgres can be dropped/recreated
freely; re-run `--apply` (idempotent) to retry.

## Verified run (real data)

Against the demo's live SQLite → fresh `runyard_primary` Postgres DB:
`--plan` 18 tables / 3544 rows → `--apply` all tables copied → `--validate`
**PASS** (every table count matched; all 6 referential checks `orphans=0`).

## Cutover plan (what remains before production)

The migration tooling + a Postgres-primary schema are done. Full cutover still
requires (deliberately not in this pass, to keep the live demo + prod safe):

1. **Store layer swap.** Port `src/*Store.js` / `src/*Records.js` from `node:sqlite`
   (synchronous `DatabaseSync`) to async Postgres (`pg`). This is the large piece:
   dozens of modules, sync→async call-site changes, and transaction semantics.
   Develop/test it in-process against **PGlite** (Docker-free) using this schema,
   then run real Postgres in prod.
2. **Schema constraints.** The migration target intentionally omits FK constraints
   (matching the Electric mirror and simplifying bulk load). The production
   Postgres-primary schema should re-add FKs + NOT NULL + defaults from
   `src/dbSchema.js`; `--validate`'s orphan checks confirm the data already
   satisfies them.
3. **Electric source switch.** Point Electric's `DATABASE_URL` at the hub's
   Postgres and delete the projector. The auth proxy, shape allowlist, per-run
   trace scoping, and frontend shape client are unchanged.
4. **Ops.** Backups (pg_dump/PITR), connection pooling, migrations tool
   (e.g. node-pg-migrate) to replace the additive `ALTER TABLE` bootstrap.

## Tests

`tests/electric-migrate.test.js` (SQLite fixture → PGlite target): plan
introspection + sensitive-table exclusion, DDL type mapping (jsonb/bigint/pk),
copy fidelity (jsonb round-trip, lineage), idempotent re-apply (no dupes), and
orphan detection. `tests/pglite-schema.test.js` validates the mirror schema +
projector SQL under real Postgres semantics.
