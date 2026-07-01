import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  planMigration,
  applyMigration,
  validateMigration,
  introspectSqlite,
  buildCreateTable,
  SENSITIVE_TABLES
} from "../src/electric/migrate.js";

// Builds an in-memory SQLite fixture resembling RunYard's core tables.
function makeFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, capability_slug TEXT NOT NULL, capability_name TEXT NOT NULL,
      status TEXT NOT NULL, input TEXT NOT NULL DEFAULT '{}', output TEXT, error TEXT,
      runner_id TEXT, parent_run_id TEXT, attempt INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE TABLE runners (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'offline', capacity INTEGER, active_runs INTEGER, created_at TEXT NOT NULL
    );
    CREATE TABLE secrets (key TEXT PRIMARY KEY, value_encrypted BLOB NOT NULL);
  `);
  db.prepare(`INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "run_1", "improve/frontend", "Improve Frontend", "succeeded", '{"repo":"x"}',
    '{"ok":true}', null, "runner_1", null, 0, "2026-07-01T00:00:00.000Z", "2026-07-01T00:05:00.000Z"
  );
  db.prepare(`INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "run_2", "improve/frontend", "Improve Frontend", "running", "{}", null, null,
    "runner_1", "run_1", 1, "2026-07-01T00:06:00.000Z", "2026-07-01T00:06:00.000Z"
  );
  db.prepare(`INSERT INTO run_events VALUES (?,?,?,?,?,?)`).run(
    "evt_1", "run_1", "agent.thinking", "planning", '{"step":1}', "2026-07-01T00:00:01.000Z"
  );
  db.prepare(`INSERT INTO run_events VALUES (?,?,?,?,?,?)`).run(
    "evt_2", "run_1", "tool.shell", "$ ls", '{"step":2}', "2026-07-01T00:00:02.000Z"
  );
  db.prepare(`INSERT INTO runners VALUES (?,?,?,?,?,?,?)`).run(
    "runner_1", "hetzner-1", '["hetzner","primary"]', "online", 2, 1, "2026-07-01T00:00:00.000Z"
  );
  db.prepare(`INSERT INTO secrets VALUES (?,?)`).run("OPENAI_API_KEY", Buffer.from("encrypted-bytes"));
  return db;
}

async function makePglite(t) {
  let PGlite;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
    return await PGlite.create();
  } catch (err) {
    t.skip(`PGlite unavailable: ${err?.message || err}`);
    return null;
  }
}

test("plan introspects core tables, excludes sensitive, maps jsonb + preserves pk", () => {
  const sqlite = makeFixture();
  const plan = planMigration(sqlite);
  const names = plan.tables.map((t) => t.name);
  assert.ok(names.includes("runs") && names.includes("run_events") && names.includes("runners"));
  assert.ok(!names.includes("secrets"), "secrets must be excluded by default");
  assert.ok(SENSITIVE_TABLES.has("secrets"));

  const runs = plan.tables.find((t) => t.name === "runs");
  assert.equal(runs.rows, 2);
  assert.deepEqual(runs.pk, ["id"]);
  assert.ok(runs.jsonbColumns.includes("input") && runs.jsonbColumns.includes("output"));

  const events = plan.tables.find((t) => t.name === "run_events");
  assert.equal(events.rows, 2);
  assert.ok(events.jsonbColumns.includes("data"));

  const ddl = buildCreateTable(introspectSqlite(sqlite).find((t) => t.name === "runs"));
  assert.match(ddl, /input jsonb/);
  assert.match(ddl, /attempt bigint/);
  assert.match(ddl, /created_at text/);
  assert.match(ddl, /PRIMARY KEY \(id\)/);
});

test("--include-sensitive brings in secrets (bytea)", () => {
  const sqlite = makeFixture();
  const plan = planMigration(sqlite, { includeSensitive: true });
  const secrets = plan.tables.find((t) => t.name === "secrets");
  assert.ok(secrets, "secrets included when opted in");
  const ddl = buildCreateTable(introspectSqlite(sqlite, { includeSensitive: true }).find((t) => t.name === "secrets"));
  assert.match(ddl, /value_encrypted bytea/);
});

test("apply copies with fidelity, validates, and is idempotent", async (t) => {
  const sqlite = makeFixture();
  const pg = await makePglite(t);
  if (!pg) return;

  await applyMigration({ sqlite, pg });

  const runs = await pg.query("select id, status, input->>'repo' as repo, parent_run_id, attempt, pg_typeof(input)::text as ty from runs order by id");
  assert.equal(runs.rows.length, 2);
  assert.equal(runs.rows[0].repo, "x");
  assert.equal(runs.rows[0].ty, "jsonb", "JSON text must become jsonb");
  assert.equal(runs.rows[1].parent_run_id, "run_1", "lineage preserved");
  assert.equal(Number(runs.rows[1].attempt), 1);

  const events = await pg.query("select data->>'step' as step from run_events order by id");
  assert.deepEqual(events.rows.map((r) => r.step), ["1", "2"]);

  const runners = await pg.query("select tags->>0 as first_tag from runners");
  assert.equal(runners.rows[0].first_tag, "hetzner");

  // secrets excluded -> table not created
  const secretsExists = await pg.query(
    "select count(*)::int as n from information_schema.tables where table_name='secrets'"
  );
  assert.equal(secretsExists.rows[0].n, 0);

  let report = await validateMigration({ sqlite, pg });
  assert.equal(report.ok, true);
  assert.ok(report.counts.every((c) => c.ok));
  assert.ok(report.refs.every((r) => r.orphans === 0));

  // idempotent re-run: no duplicates, still valid
  await applyMigration({ sqlite, pg });
  report = await validateMigration({ sqlite, pg });
  assert.equal(report.ok, true);
  const again = await pg.query("select count(*)::int as n from runs");
  assert.equal(again.rows[0].n, 2, "re-apply must not duplicate rows");

  await pg.close?.();
});

test("validate detects referential orphans", async (t) => {
  const sqlite = makeFixture();
  // an event whose run_id has no matching run
  sqlite.prepare(`INSERT INTO run_events VALUES (?,?,?,?,?,?)`).run(
    "evt_orphan", "run_missing", "log", "orphan", "{}", "2026-07-01T00:00:03.000Z"
  );
  const pg = await makePglite(t);
  if (!pg) return;
  await applyMigration({ sqlite, pg });
  const report = await validateMigration({ sqlite, pg });
  const eventRef = report.refs.find((r) => r.name.startsWith("run_events.run_id"));
  assert.ok(eventRef.orphans >= 1, "orphan event must be flagged");
  assert.equal(report.ok, false);
  await pg.close?.();
});
