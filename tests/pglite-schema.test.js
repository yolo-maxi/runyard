import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildMultiUpsert } from "../src/electric/upsertSql.js";

// PGlite migration-proof harness.
//
// This demonstrates PGlite's genuinely useful role in the Electric migration:
// an in-process, Docker-free *real Postgres* to validate that the mirror schema
// and the projector's generated SQL are Postgres-correct (not SQLite-isms) — the
// exact SQL a Postgres-primary cutover would run. See
// specs/pglite-migration-evaluation.md. It does NOT (and cannot) test PGlite as
// an Electric source: Electric consumes a logical-replication stream over a
// DATABASE_URL, which embedded single-connection PGlite does not expose.
//
// Skips cleanly if the PGlite WASM runtime can't load in this environment.
async function loadPGlite() {
  try {
    const mod = await import("@electric-sql/pglite");
    return await mod.PGlite.create();
  } catch (err) {
    return { __unavailable: err?.message || String(err) };
  }
}

const schemaPath = fileURLToPath(new URL("../electric/pg-schema.sql", import.meta.url));

test("mirror schema loads under real Postgres (PGlite) and creates every shape table", async (t) => {
  const pg = await loadPGlite();
  if (pg.__unavailable) return t.skip(`PGlite unavailable: ${pg.__unavailable}`);
  await pg.exec(readFileSync(schemaPath, "utf8"));
  const { rows } = await pg.query(
    "select table_name from information_schema.tables where table_schema = $1 order by 1",
    ["public"]
  );
  const tables = rows.map((r) => r.table_name);
  for (const expected of ["approvals", "artifacts", "capabilities", "run_events", "runners", "runs"]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  await pg.close?.();
});

test("projector upsert SQL runs on real Postgres: jsonb cast + conflict update", async (t) => {
  const pg = await loadPGlite();
  if (pg.__unavailable) return t.skip(`PGlite unavailable: ${pg.__unavailable}`);
  await pg.exec(readFileSync(schemaPath, "utf8"));

  const cols = ["id", "status", "input"];
  const jsonCols = new Set(["input"]);
  const ins = buildMultiUpsert("runs", cols, jsonCols, "id", [
    { id: "run_1", status: "running", input: '{"repo":"x"}' }
  ]);
  await pg.query(ins.text, ins.values);

  // Same primary key again -> ON CONFLICT DO UPDATE (idempotent mirror re-tick).
  const upd = buildMultiUpsert("runs", cols, jsonCols, "id", [
    { id: "run_1", status: "succeeded", input: '{"repo":"x"}' }
  ]);
  await pg.query(upd.text, upd.values);

  const { rows } = await pg.query(
    "select id, status, input->>'repo' as repo, pg_typeof(input)::text as input_type from runs"
  );
  assert.equal(rows.length, 1, "conflict update must not duplicate the row");
  assert.equal(rows[0].status, "succeeded");
  assert.equal(rows[0].repo, "x");
  assert.equal(rows[0].input_type, "jsonb", "JSON text must land as real jsonb");
  await pg.close?.();
});

test("run_events bigint pk + jsonb data behave as Postgres (trace stream shape)", async (t) => {
  const pg = await loadPGlite();
  if (pg.__unavailable) return t.skip(`PGlite unavailable: ${pg.__unavailable}`);
  await pg.exec(readFileSync(schemaPath, "utf8"));
  await pg.query(
    "insert into run_events (seq, id, run_id, type, message, data, created_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7)",
    [1, "evt_1", "run_1", "agent.thinking", "planning", JSON.stringify({ step: 3 }), "2026-07-01T00:00:00.000Z"]
  );
  const { rows } = await pg.query("select seq, data->>'step' as step from run_events where seq = 1");
  assert.equal(Number(rows[0].seq), 1);
  assert.equal(rows[0].step, "3");
  await pg.close?.();
});
