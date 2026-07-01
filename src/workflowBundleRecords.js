import { createHash } from "node:crypto";

// DB-backed workflow bundles are append-only: every publish inserts a new
// (capability_slug, version) row and rows are never updated in place, so a
// bundle id always names the exact bytes it was published with.

export function normalizeWorkflowBundle(row, { includeCode = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    capabilitySlug: row.capability_slug,
    version: row.version,
    language: row.language,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(includeCode ? { code: row.code } : {})
  };
}

export function workflowBundleSha256(code) {
  return createHash("sha256").update(String(code), "utf8").digest("hex");
}

export function workflowBundleInsertQuery() {
  return {
    sql: `INSERT INTO workflow_bundles
     (id, capability_slug, version, language, code, size_bytes, sha256, created_by, created_at)
     VALUES ($id, $capability_slug, $version, $language, $code, $size_bytes, $sha256, $created_by, $created_at)`
  };
}

export function workflowBundleByIdQuery(bundleId) {
  return {
    sql: "SELECT * FROM workflow_bundles WHERE id = ?",
    params: [bundleId]
  };
}

export function workflowBundleLatestVersionQuery(capabilitySlug) {
  return {
    sql: "SELECT MAX(version) AS version FROM workflow_bundles WHERE capability_slug = ?",
    params: [capabilitySlug]
  };
}

export function workflowBundleListQuery({ capabilitySlug = "" } = {}) {
  if (capabilitySlug) {
    return {
      sql: "SELECT * FROM workflow_bundles WHERE capability_slug = ? ORDER BY capability_slug, version DESC",
      params: [capabilitySlug]
    };
  }
  return {
    sql: "SELECT * FROM workflow_bundles ORDER BY capability_slug, version DESC",
    params: []
  };
}
