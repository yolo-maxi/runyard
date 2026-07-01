export function cleanSecretKey(key) {
  return String(key || "").trim();
}

export function normalizeSecretMeta(row) {
  if (!row) return null;
  return {
    key: row.key,
    description: row.description || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by || ""
  };
}

export function secretUpsertParams({
  key,
  encryptedValue,
  description = "",
  createdBy = "",
  timestamp
}) {
  return {
    key: cleanSecretKey(key),
    valueEncrypted: encryptedValue,
    description: String(description || ""),
    createdBy: String(createdBy || ""),
    timestamp
  };
}

export function uniqueSecretNames(names = []) {
  return [
    ...new Set(
      (Array.isArray(names) ? names : [])
        .map(cleanSecretKey)
        .filter(Boolean)
    )
  ];
}

export function secretMetaListQuery() {
  return {
    sql: "SELECT key, description, created_at, updated_at, created_by FROM secrets ORDER BY key",
    params: []
  };
}

export function secretKeyQuery(key) {
  return {
    sql: "SELECT key FROM secrets WHERE key = ?",
    params: [cleanSecretKey(key)]
  };
}

export function secretExistingMetaQuery(key) {
  return {
    sql: "SELECT key, created_at, created_by FROM secrets WHERE key = ?",
    params: [cleanSecretKey(key)]
  };
}

export function secretMetaQuery(key) {
  return {
    sql: "SELECT key, description, created_at, updated_at, created_by FROM secrets WHERE key = ?",
    params: [cleanSecretKey(key)]
  };
}

export function secretEncryptedValueQuery(key) {
  return {
    sql: "SELECT value_encrypted FROM secrets WHERE key = ?",
    params: [cleanSecretKey(key)]
  };
}

export function allSecretEncryptedValuesQuery() {
  return {
    sql: "SELECT value_encrypted FROM secrets",
    params: []
  };
}

export function secretUpdateQuery(payload) {
  return {
    sql: "UPDATE secrets SET value_encrypted = ?, description = ?, updated_at = ? WHERE key = ?",
    params: [payload.valueEncrypted, payload.description, payload.timestamp, payload.key]
  };
}

export function secretInsertQuery(payload) {
  return {
    sql: "INSERT INTO secrets (key, value_encrypted, description, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    params: [payload.key, payload.valueEncrypted, payload.description, payload.timestamp, payload.timestamp, payload.createdBy]
  };
}

export function secretDeleteQuery(key) {
  return {
    sql: "DELETE FROM secrets WHERE key = ?",
    params: [cleanSecretKey(key)]
  };
}
