import { parseMaybeJson } from "./dbNormalization.js";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function auditRecord({ id, actor, action, target = null, detail = {}, createdAt }) {
  return {
    id,
    actor: actor || "",
    action,
    target,
    detail: jsonField(detail, {}),
    created_at: createdAt
  };
}

export function normalizeAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    detail: parseMaybeJson(row.detail, {}),
    createdAt: row.created_at
  };
}

export function auditListQuery({ limit = 100 } = {}) {
  return {
    sql: "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?",
    params: [limit]
  };
}

export function auditInsertQuery() {
  return {
    sql: "INSERT INTO audit_log (id, actor, action, target, detail, created_at) VALUES ($id, $actor, $action, $target, $detail, $created_at)"
  };
}
