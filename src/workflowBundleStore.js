import { MAX_WORKFLOW_BUNDLE_BYTES, workflowBundleSizeError } from "./workflowSource.js";
import {
  normalizeWorkflowBundle,
  workflowBundleByIdQuery,
  workflowBundleInsertQuery,
  workflowBundleLatestVersionQuery,
  workflowBundleListQuery,
  workflowBundleSha256
} from "./workflowBundleRecords.js";

export function createWorkflowBundleStore({ all, one, run, id, now }) {
  // Publish is insert-only: a new version row per publish, never an in-place
  // edit. The 500 KB cap is enforced here — before the insert — so an
  // oversized bundle can never reach the DB and trip blob/RPC/transport
  // ceilings at run time.
  function publishWorkflowBundle({ capabilitySlug, code, language = "", createdBy = "" } = {}) {
    const slug = String(capabilitySlug || "").trim();
    if (!slug || !/^[A-Za-z0-9_-]+$/.test(slug)) {
      throw new Error("workflow bundle capabilitySlug is required (letters, digits, - and _ only)");
    }
    if (typeof code !== "string" || !code.trim()) {
      throw new Error("workflow bundle code is required");
    }
    const sizeBytes = Buffer.byteLength(code, "utf8");
    const sizeMessage = workflowBundleSizeError({ sizeBytes, relativePath: slug });
    if (sizeMessage) {
      const error = new Error(sizeMessage);
      error.code = "workflow_bundle_too_large";
      error.sizeBytes = sizeBytes;
      error.maxWorkflowBundleBytes = MAX_WORKFLOW_BUNDLE_BYTES;
      throw error;
    }
    const latestQuery = workflowBundleLatestVersionQuery(slug);
    const latest = one(latestQuery.sql, latestQuery.params);
    const record = {
      id: id("wfb"),
      capability_slug: slug,
      version: (latest?.version || 0) + 1,
      language: normalizeWorkflowBundleLanguage(language),
      code,
      size_bytes: sizeBytes,
      sha256: workflowBundleSha256(code),
      created_by: String(createdBy || ""),
      created_at: now()
    };
    const insert = workflowBundleInsertQuery();
    run(insert.sql, record);
    return normalizeWorkflowBundle(record);
  }

  function getWorkflowBundle(bundleId, { includeCode = true } = {}) {
    const query = workflowBundleByIdQuery(String(bundleId || "").trim());
    return normalizeWorkflowBundle(one(query.sql, query.params), { includeCode });
  }

  // Metadata only — listing never ships bundle bytes.
  function listWorkflowBundles({ capabilitySlug = "" } = {}) {
    const query = workflowBundleListQuery({ capabilitySlug });
    return all(query.sql, query.params).map((row) => normalizeWorkflowBundle(row));
  }

  return {
    getWorkflowBundle,
    listWorkflowBundles,
    publishWorkflowBundle
  };
}

function normalizeWorkflowBundleLanguage(language) {
  const cleaned = String(language || "").trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]{1,10}$/.test(cleaned) ? cleaned : "tsx";
}
