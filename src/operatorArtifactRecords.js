import { parseMaybeJson } from "./dbNormalization.js";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function artifactRecord({ id, runId, name, kind = "file", mimeType = "application/octet-stream", sizeBytes = 0, path, metadata = {}, createdAt }) {
  return {
    id,
    run_id: runId,
    name,
    kind,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    path,
    metadata: jsonField(metadata, {}),
    created_at: createdAt
  };
}

export function normalizeArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    path: row.path,
    metadata: parseMaybeJson(row.metadata, {}),
    createdAt: row.created_at
  };
}

export function artifactListQuery({ runId = "", q = "" } = {}) {
  if (runId) {
    return {
      sql: "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC",
      params: [runId]
    };
  }
  if (q) {
    const like = `%${q}%`;
    return {
      sql: "SELECT * FROM artifacts WHERE name LIKE ? OR metadata LIKE ? ORDER BY created_at DESC LIMIT 100",
      params: [like, like]
    };
  }
  return {
    sql: "SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 100",
    params: []
  };
}

export function artifactInsertQuery() {
  return {
    sql: `INSERT INTO artifacts (id, run_id, name, kind, mime_type, size_bytes, path, metadata, created_at)
     VALUES ($id, $run_id, $name, $kind, $mime_type, $size_bytes, $path, $metadata, $created_at)`
  };
}

export function artifactLookupQuery(artifactId) {
  return {
    sql: "SELECT * FROM artifacts WHERE id = ?",
    params: [artifactId]
  };
}
