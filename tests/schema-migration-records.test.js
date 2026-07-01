import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  missingColumnAlterQueries,
  tableColumnsQuery
} from "../src/schemaMigrationRecords.js";

describe("schema migration record helpers", () => {
  it("builds table column inspection queries with quoted identifiers", () => {
    assert.deepEqual(tableColumnsQuery("runners"), {
      sql: 'PRAGMA table_info("runners")',
      params: []
    });
  });

  it("builds ALTER queries only for missing columns", () => {
    assert.deepEqual(missingColumnAlterQueries({
      table: "runs",
      existingColumns: ["id", "attempt"],
      columns: [
        { name: "attempt", definition: "attempt INTEGER NOT NULL DEFAULT 0" },
        { name: "supervisor_meta", definition: "supervisor_meta TEXT" }
      ]
    }), [
      {
        sql: 'ALTER TABLE "runs" ADD COLUMN supervisor_meta TEXT',
        params: []
      }
    ]);
  });

  it("rejects unsafe SQL identifiers", () => {
    assert.throws(() => tableColumnsQuery("runs; DROP TABLE runs"), /Invalid SQL identifier/);
    assert.throws(() => missingColumnAlterQueries({ table: "bad-name", columns: [] }), /Invalid SQL identifier/);
  });
});
