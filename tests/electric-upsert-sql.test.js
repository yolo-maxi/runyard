import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMultiUpsert, placeholder } from "../src/electric/upsertSql.js";

test("placeholder casts json columns to jsonb", () => {
  const jsonCols = new Set(["data"]);
  assert.equal(placeholder("id", 1, jsonCols), "$1");
  assert.equal(placeholder("data", 2, jsonCols), "$2::jsonb");
});

test("buildMultiUpsert emits parameterized multi-row insert with conflict update", () => {
  const rows = [
    { id: "a", status: "running", input: "{}" },
    { id: "b", status: "done", input: '{"x":1}' }
  ];
  const { text, values } = buildMultiUpsert("runs", ["id", "status", "input"], new Set(["input"]), "id", rows);
  assert.match(text, /INSERT INTO runs \(id, status, input\) VALUES/);
  assert.match(text, /\(\$1, \$2, \$3::jsonb\), \(\$4, \$5, \$6::jsonb\)/);
  assert.match(text, /ON CONFLICT \(id\) DO UPDATE SET status = EXCLUDED\.status, input = EXCLUDED\.input/);
  assert.ok(!/id = EXCLUDED\.id/.test(text), "primary key must not be in the update set");
  assert.deepEqual(values, ["a", "running", "{}", "b", "done", '{"x":1}']);
});

test("buildMultiUpsert normalizes undefined columns to null", () => {
  const { values } = buildMultiUpsert("t", ["id", "note"], new Set(), "id", [{ id: "x" }]);
  assert.deepEqual(values, ["x", null]);
});

test("buildMultiUpsert falls back to DO NOTHING when only the pk is present", () => {
  const { text } = buildMultiUpsert("t", ["id"], new Set(), "id", [{ id: "x" }]);
  assert.match(text, /ON CONFLICT \(id\) DO NOTHING/);
});
