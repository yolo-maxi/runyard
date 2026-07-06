import { actorName } from "./routeActors.js";
import { loadWorkflowSource } from "./workflowSource.js";
import {
  buildWorkflowPackage,
  finalizeImportedCapability,
  validateWorkflowPackage,
  workflowPackageFilename,
  workflowPackageImportPlan
} from "./workflowPackage.js";

export function createWorkflowPackageHandlers({
  getCapability,
  getWorkflowBundle,
  publishWorkflowBundle,
  recordAudit,
  root,
  upsertCapability,
  env = process.env
} = {}) {
  const loadPackageSource = (capability) => loadWorkflowSource(capability, { root, getWorkflowBundle });

  return {
    exportWorkflowPackage(req, res) {
      const capability = getCapability(req.params.id);
      if (!capability) return res.status(404).json({ error: "capability not found" });
      let source;
      try {
        source = loadPackageSource(capability);
      } catch (error) {
        if (error.code !== "workflow_bundle_missing") throw error;
        return res.status(409).json({ error: error.message, bundleId: error.bundleId });
      }
      if (!source) return res.status(409).json({ error: "workflow source unavailable for this capability" });
      const workflowPackage = buildWorkflowPackage({
        capability,
        source,
        exportedBy: actorName(req.token),
        hubVersion: env.version || ""
      });
      recordAudit(actorName(req.token), "workflow_package.exported", capability.slug, {
        contentHash: workflowPackage.contentHash,
        sizeBytes: workflowPackage.workflow.sizeBytes
      });
      res.setHeader("Content-Disposition", `attachment; filename="${workflowPackageFilename(capability.slug, workflowPackage.contentHash)}"`);
      res.json({ workflowPackage });
    },

    previewWorkflowPackageImport(req, res) {
      const plan = workflowPackageImportPlan(req.body?.workflowPackage ?? req.body, {
        slugOverride: req.body?.slug || req.body?.targetSlug || ""
      });
      if (!plan.ok) return res.status(400).json({ errors: plan.errors, report: plan.report });
      res.json({ report: plan.report, capability: plan.capability });
    },

    importWorkflowPackage(req, res) {
      const plan = workflowPackageImportPlan(req.body?.workflowPackage ?? req.body, {
        slugOverride: req.body?.slug || req.body?.targetSlug || ""
      });
      if (!plan.ok) return res.status(400).json({ errors: plan.errors, report: plan.report });
      try {
        const bundle = publishWorkflowBundle({
          capabilitySlug: plan.report.targetSlug,
          code: plan.package.workflow.code,
          language: plan.package.workflow.language,
          createdBy: actorName(req.token)
        });
        const capability = upsertCapability(finalizeImportedCapability(plan.capability, bundle));
        recordAudit(actorName(req.token), "workflow_package.imported", capability.slug, {
          contentHash: plan.report.contentHash,
          sourceCapabilitySlug: plan.package.capability.slug,
          bundleId: bundle.id,
          bundleSha256: bundle.sha256,
          enabled: capability.enabled
        });
        res.status(201).json({
          report: { ...plan.report, imported: true, bundleId: bundle.id, bundleSha256: bundle.sha256 },
          bundle,
          capability
        });
      } catch (error) {
        if (error.code === "workflow_bundle_too_large") {
          return res.status(413).json({
            error: error.message,
            sizeBytes: error.sizeBytes,
            maxWorkflowBundleBytes: error.maxWorkflowBundleBytes
          });
        }
        res.status(400).json({ error: error.message || "workflow package import failed" });
      }
    },

    validateWorkflowPackage(req, res) {
      const validation = validateWorkflowPackage(req.body?.workflowPackage ?? req.body);
      if (!validation.ok) return res.status(400).json({ errors: validation.errors, report: validation.report });
      res.json({ report: validation.report });
    }
  };
}
