import path from "node:path";
import {
  loadWorkflowSource,
  workflowBundleReference
} from "./workflowSource.js";
import { workflowBundleSha256 } from "./workflowBundleRecords.js";

const SOURCE_FIELDS = ["source", "sourceBytes", "code"];
const TRUSTED_FILE_BACKED_VALUES = new Set(["trusted", "internal", "seed", "seeded", "dev", "legacy"]);

export function workflowHasTrustedFileBacking(definition) {
  const workflow = definition?.workflow || {};
  if (workflow.trustedFileBacked === true || workflow.fileBackedTrusted === true) return true;
  const trust = String(workflow.sourceTrust || workflow.sourceMode || "").trim().toLowerCase();
  return TRUSTED_FILE_BACKED_VALUES.has(trust);
}

export function workflowSourceBytesFromDefinition(definition) {
  for (const field of SOURCE_FIELDS) {
    const value = definition?.workflow?.[field] ?? definition?.[field === "source" ? "workflowSource" : field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function workflowLanguageFromDefinition(definition) {
  const explicit = String(definition?.workflow?.language || definition?.workflowLanguage || "").trim().replace(/^\./, "");
  if (/^[a-z0-9]{1,10}$/i.test(explicit)) return explicit.toLowerCase();
  const entry = String(definition?.workflow?.entry || definition?.workflow?.path || "").trim();
  const ext = path.extname(entry).replace(/^\./, "");
  return /^[a-z0-9]{1,10}$/i.test(ext) ? ext.toLowerCase() : "tsx";
}

export function definitionWithoutInlineWorkflowSource(definition) {
  const next = { ...definition, workflow: { ...(definition?.workflow || {}) } };
  delete next.workflow.source;
  delete next.workflow.sourceBytes;
  delete next.workflow.code;
  delete next.workflow.language;
  delete next.workflowLanguage;
  delete next.workflowSource;
  delete next.sourceBytes;
  delete next.code;
  return next;
}

export function findReusableWorkflowBundle({ listWorkflowBundles, capabilitySlug, sha256 }) {
  if (typeof listWorkflowBundles !== "function") return null;
  const bundles = listWorkflowBundles({ capabilitySlug }) || [];
  return bundles.find((bundle) => bundle.sha256 === sha256) || null;
}

export function publishWorkflowDefinitionSource({
  definition,
  publishWorkflowBundle,
  listWorkflowBundles = null,
  createdBy = ""
} = {}) {
  const code = workflowSourceBytesFromDefinition(definition);
  if (!code) return { definition, bundle: null, reused: false };
  if (typeof publishWorkflowBundle !== "function") {
    throw new Error("workflow source bytes were provided, but workflow bundle publishing is not available");
  }
  const capabilitySlug = String(definition?.slug || "").trim();
  const sha256 = workflowBundleSha256(code);
  const reusable = findReusableWorkflowBundle({ listWorkflowBundles, capabilitySlug, sha256 });
  const bundle = reusable || publishWorkflowBundle({
    capabilitySlug,
    code,
    language: workflowLanguageFromDefinition(definition),
    createdBy
  });
  const cleaned = definitionWithoutInlineWorkflowSource(definition);
  cleaned.workflow = { ...(cleaned.workflow || {}), bundleId: bundle.id };
  return { definition: cleaned, bundle, reused: Boolean(reusable) };
}

export function publishTrustedSeedWorkflowSource({
  definition,
  root,
  publishWorkflowBundle,
  listWorkflowBundles = null,
  createdBy = "seed"
} = {}) {
  if (workflowBundleReference(definition)) return { definition, bundle: null, reused: true };
  const source = loadWorkflowSource(definition, { root });
  if (!source?.code) {
    throw new Error(`seeded workflow ${definition?.slug || "unknown"} has no source file to publish as a DB workflow bundle`);
  }
  return publishWorkflowDefinitionSource({
    definition: {
      ...definition,
      workflow: {
        ...(definition.workflow || {}),
        code: source.code,
        language: source.language
      }
    },
    publishWorkflowBundle,
    listWorkflowBundles,
    createdBy
  });
}

export function normalizePublicWorkflowDefinition({
  definition,
  getWorkflowBundle = null,
  publishWorkflowBundle = null,
  createdBy = ""
} = {}) {
  const source = workflowSourceBytesFromDefinition(definition);
  if (source) {
    return publishWorkflowDefinitionSource({ definition, publishWorkflowBundle, createdBy }).definition;
  }

  const bundleId = workflowBundleReference(definition);
  if (bundleId) {
    const bundle = typeof getWorkflowBundle === "function" ? getWorkflowBundle(bundleId) : null;
    if (!bundle) {
      const error = new Error(`workflow bundle ${bundleId} not found; provide source bytes or publish the bundle before referencing it`);
      error.code = "workflow_bundle_missing";
      error.bundleId = bundleId;
      throw error;
    }
    return definitionWithoutInlineWorkflowSource(definition);
  }

  if (workflowHasTrustedFileBacking(definition)) return definitionWithoutInlineWorkflowSource(definition);

  const error = new Error("custom workflows must provide workflow source bytes or an existing workflow.bundleId; bare workflow.entry file paths are reserved for trusted internal/dev seeded workflows");
  error.code = "workflow_source_required";
  throw error;
}
