export function normalizeAlert(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    level: row.level,
    title: row.title,
    message: row.message,
    data: alertData(row.data),
    createdAt: row.created_at
  };
}

export function alertRecord({
  id,
  kind,
  level = "info",
  title = "",
  message = "",
  data = {},
  createdAt
}) {
  if (!kind) throw new Error("recordAlert: kind is required");
  return {
    id,
    kind: String(kind),
    level: String(level || "info"),
    title: String(title || "").slice(0, 200),
    message: String(message || "").slice(0, 2000),
    data: JSON.stringify(data === undefined ? {} : data),
    created_at: createdAt
  };
}

export function alertInsertQuery() {
  return {
    sql: "INSERT INTO _smithers_alerts (id, kind, level, title, message, data, created_at) VALUES ($id, $kind, $level, $title, $message, $data, $created_at)",
    params: []
  };
}

export function alertData(value) {
  if (typeof value !== "string") return value || {};
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function alertLimit(value, fallback = 50) {
  return Math.min(Math.max(Number(value) || fallback, 1), 500);
}

export function alertListQuery({ kind = "", limit = 50 } = {}) {
  const capped = alertLimit(limit);
  const cleanKind = String(kind || "");
  return cleanKind
    ? {
        sql: "SELECT * FROM _smithers_alerts WHERE kind = ? ORDER BY created_at DESC LIMIT ?",
        params: [cleanKind, capped]
      }
    : {
        sql: "SELECT * FROM _smithers_alerts ORDER BY created_at DESC LIMIT ?",
        params: [capped]
      };
}

export function latestAlertQuery(kind = "") {
  const cleanKind = String(kind || "");
  return cleanKind
    ? {
        sql: "SELECT * FROM _smithers_alerts WHERE kind = ? ORDER BY created_at DESC LIMIT 1",
        params: [cleanKind]
      }
    : {
        sql: "SELECT * FROM _smithers_alerts ORDER BY created_at DESC LIMIT 1",
        params: []
      };
}
