import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alertData,
  alertInsertQuery,
  alertLimit,
  alertListQuery,
  alertRecord,
  latestAlertQuery,
  normalizeAlert
} from "../src/alertPresentation.js";

describe("alert presentation helpers", () => {
  it("normalizes alert rows and parses JSON data", () => {
    assert.deepEqual(normalizeAlert({
      id: "alert_1",
      kind: "update",
      level: "error",
      title: "Update failed",
      message: "rolled back",
      data: '{"from":"v2","to":"v1"}',
      created_at: "2026-06-30T00:00:00.000Z"
    }), {
      id: "alert_1",
      kind: "update",
      level: "error",
      title: "Update failed",
      message: "rolled back",
      data: { from: "v2", to: "v1" },
      createdAt: "2026-06-30T00:00:00.000Z"
    });
    assert.equal(normalizeAlert(null), null);
  });

  it("keeps alert data forgiving for old or malformed rows", () => {
    assert.deepEqual(alertData({ ok: true }), { ok: true });
    assert.deepEqual(alertData(""), {});
    assert.deepEqual(alertData("{bad"), {});
    assert.deepEqual(alertData(null), {});
  });

  it("bounds list limits for alert queries", () => {
    assert.equal(alertLimit("10"), 10);
    assert.equal(alertLimit("999"), 500);
    assert.equal(alertLimit("-1"), 1);
    assert.equal(alertLimit("bad"), 50);
  });

  it("builds alert records with bounded text fields", () => {
    assert.throws(() => alertRecord({ id: "alert_1", kind: "", createdAt: "now" }), /kind is required/);
    const record = alertRecord({
      id: "alert_1",
      kind: "update",
      level: "",
      title: "t".repeat(250),
      message: "m".repeat(2100),
      data: { ok: true },
      createdAt: "2026-06-30T00:00:00.000Z"
    });

    assert.equal(record.level, "info");
    assert.equal(record.title.length, 200);
    assert.equal(record.message.length, 2000);
    assert.equal(record.data, '{"ok":true}');
  });

  it("builds alert list and latest queries", () => {
    assert.deepEqual(alertInsertQuery(), {
      sql: "INSERT INTO _smithers_alerts (id, kind, level, title, message, data, created_at) VALUES ($id, $kind, $level, $title, $message, $data, $created_at)",
      params: []
    });
    assert.deepEqual(alertListQuery({ kind: "update", limit: "999" }), {
      sql: "SELECT * FROM _smithers_alerts WHERE kind = ? ORDER BY created_at DESC LIMIT ?",
      params: ["update", 500]
    });
    assert.deepEqual(alertListQuery({ limit: 2 }), {
      sql: "SELECT * FROM _smithers_alerts ORDER BY created_at DESC LIMIT ?",
      params: [2]
    });
    assert.deepEqual(latestAlertQuery("update"), {
      sql: "SELECT * FROM _smithers_alerts WHERE kind = ? ORDER BY created_at DESC LIMIT 1",
      params: ["update"]
    });
    assert.deepEqual(latestAlertQuery(), {
      sql: "SELECT * FROM _smithers_alerts ORDER BY created_at DESC LIMIT 1",
      params: []
    });
  });
});
