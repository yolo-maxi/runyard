import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  settingDefaultInsertQuery,
  settingLookupQuery
} from "../src/settingsRecords.js";

describe("settings record helpers", () => {
  it("builds setting lookup and default insert queries", () => {
    assert.deepEqual(settingLookupQuery("instance_name"), {
      sql: "SELECT key FROM settings WHERE key = ?",
      params: ["instance_name"]
    });
    assert.deepEqual(settingDefaultInsertQuery({
      key: "instance_name",
      value: 42,
      timestamp: "2026-01-01T00:00:00.000Z"
    }), {
      sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
      params: ["instance_name", "42", "2026-01-01T00:00:00.000Z"]
    });
  });
});
