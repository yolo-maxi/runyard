import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auditInsertQuery,
  auditListQuery,
  auditRecord,
  normalizeAudit
} from "../src/operatorAuditRecords.js";

describe("operator audit record helpers", () => {
  it("builds and normalizes audit entries", () => {
    const record = auditRecord({
      id: "aud_1",
      actor: "",
      action: "token.created",
      target: "tok_1",
      detail: { scopes: ["api"] },
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(record.actor, "");
    assert.equal(record.detail, '{"scopes":["api"]}');
    assert.deepEqual(normalizeAudit(record), {
      id: "aud_1",
      actor: "",
      action: "token.created",
      target: "tok_1",
      detail: { scopes: ["api"] },
      createdAt: "2026-01-01T00:00:00.000Z"
    });
  });

  it("builds audit list and insert queries", () => {
    assert.deepEqual(auditListQuery({ limit: 25 }), {
      sql: "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?",
      params: [25]
    });
    assert.deepEqual(auditInsertQuery(), {
      sql: "INSERT INTO audit_log (id, actor, action, target, detail, created_at) VALUES ($id, $actor, $action, $target, $detail, $created_at)"
    });
  });
});
