import { actorName } from "./routeActors.js";

export function createWorkflowBundleHandlers({
  getWorkflowBundle,
  listWorkflowBundles,
  publishWorkflowBundle,
  recordAudit
} = {}) {
  return {
    listWorkflowBundles(req, res) {
      // ?workflow= is canonical; ?capability= is the legacy alias.
      const capabilitySlug = String(req.query.workflow || req.query.capability || "").trim();
      res.json({ bundles: listWorkflowBundles({ capabilitySlug }) });
    },

    getWorkflowBundle(req, res) {
      const bundle = getWorkflowBundle(req.params.id);
      if (!bundle) return res.status(404).json({ error: "workflow bundle not found" });
      res.json({ bundle });
    },

    publishWorkflowBundle(req, res) {
      try {
        const bundle = publishWorkflowBundle({
          capabilitySlug: req.body.workflowSlug || req.body.capabilitySlug || req.body.capability_slug || "",
          code: req.body.code,
          language: req.body.language || "",
          createdBy: actorName(req.token)
        });
        recordAudit(actorName(req.token), "workflow_bundle.published", bundle.id, {
          capabilitySlug: bundle.capabilitySlug,
          version: bundle.version,
          sizeBytes: bundle.sizeBytes,
          sha256: bundle.sha256
        });
        res.json({ bundle });
      } catch (error) {
        if (error.code === "workflow_bundle_too_large") {
          return res.status(413).json({
            error: error.message,
            sizeBytes: error.sizeBytes,
            maxWorkflowBundleBytes: error.maxWorkflowBundleBytes
          });
        }
        res.status(400).json({ error: error.message || "invalid workflow bundle" });
      }
    }
  };
}
