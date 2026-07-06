import { createHash } from "node:crypto";
import { normalizeCapabilityDefinition } from "./capabilityRecords.js";
import { stableJsonString } from "./stableJson.js";
import { workflowBundleSha256 } from "./workflowBundleRecords.js";
import { workflowBundleSizeError } from "./workflowSource.js";

export const WORKFLOW_PACKAGE_SCHEMA = "runyard.workflow-package.v1";

const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

export function workflowPackageFilename(slug, hash = "") {
  const safeSlug = sanitizePackageSlug(slug || "workflow") || "workflow";
  const suffix = String(hash || "").slice(0, 12);
  return `${safeSlug}${suffix ? `-${suffix}` : ""}.runyard-workflow.json`;
}

export function buildWorkflowPackage({ capability, source, exportedAt = new Date().toISOString(), exportedBy = "", hubVersion = "" } = {}) {
  if (!capability?.slug) throw new Error("capability is required");
  if (!source?.code) throw new Error("workflow source is required");

  const capabilityDefinition = packageCapabilityDefinition(capability);
  const workflow = {
    language: source.language || "tsx",
    code: String(source.code),
    sizeBytes: Buffer.byteLength(String(source.code), "utf8"),
    sha256: source.sha256 || workflowBundleSha256(source.code),
    sourcePath: source.relativePath || ""
  };
  const sizeError = workflowBundleSizeError(workflow);
  if (sizeError) {
    const error = new Error(sizeError);
    error.code = "workflow_package_too_large";
    error.sizeBytes = workflow.sizeBytes;
    throw error;
  }

  const core = {
    schema: WORKFLOW_PACKAGE_SCHEMA,
    package: {
      name: capability.name || capability.slug,
      version: String(capability.version || 1),
      exportedAt,
      exportedBy,
      hubVersion
    },
    capability: capabilityDefinition,
    workflow,
    requirements: {
      runnerTags: capabilityDefinition.requiredRunnerTags,
      skills: capabilityDefinition.requiredSkills,
      agents: capabilityDefinition.requiredAgents,
      declaredSecrets: declaredSecretNames(capabilityDefinition),
      hooks: declaredHookProfiles(capabilityDefinition)
    }
  };
  return { ...core, contentHash: workflowPackageContentHash(core) };
}

export function normalizeWorkflowPackageInput(input) {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      const error = new Error("workflow package JSON is invalid");
      error.code = "workflow_package_invalid_json";
      throw error;
    }
  }
  if (raw?.package && raw?.capability && raw?.workflow) return raw;
  if (raw?.workflowPackage) return normalizeWorkflowPackageInput(raw.workflowPackage);
  if (raw?.packageJson) return normalizeWorkflowPackageInput(raw.packageJson);
  if (raw?.file) return normalizeWorkflowPackageInput(raw.file);
  return raw;
}

export function validateWorkflowPackage(input) {
  const pkg = normalizeWorkflowPackageInput(input);
  const errors = [];
  if (!pkg || typeof pkg !== "object") {
    return { ok: false, errors: ["workflow package must be an object"], package: null };
  }
  if (pkg.schema !== WORKFLOW_PACKAGE_SCHEMA) errors.push(`schema must be ${WORKFLOW_PACKAGE_SCHEMA}`);
  const slug = String(pkg.capability?.slug || "").trim();
  if (!slug || !SLUG_PATTERN.test(slug)) errors.push("capability.slug is required (letters, digits, - and _ only)");
  if (!String(pkg.capability?.name || "").trim()) errors.push("capability.name is required");
  const code = pkg.workflow?.code;
  if (typeof code !== "string" || !code.trim()) errors.push("workflow.code is required");
  const sizeBytes = Buffer.byteLength(String(code || ""), "utf8");
  const sizeError = workflowBundleSizeError({ sizeBytes, relativePath: slug || "workflow package" });
  if (sizeError) errors.push(sizeError);
  const declaredSha = String(pkg.workflow?.sha256 || "").trim();
  const actualSha = workflowBundleSha256(String(code || ""));
  if (declaredSha && declaredSha !== actualSha) errors.push("workflow.sha256 does not match workflow.code");

  const { contentHash, ...withoutHash } = pkg;
  const expectedHash = workflowPackageContentHash(withoutHash);
  if (contentHash && contentHash !== expectedHash) errors.push("contentHash does not match package contents");

  return {
    ok: errors.length === 0,
    errors,
    package: pkg,
    report: workflowPackageReport(pkg, { actualSha, expectedHash, sizeBytes, valid: errors.length === 0 })
  };
}

export function workflowPackageImportPlan(input, { slugOverride = "" } = {}) {
  const validation = validateWorkflowPackage(input);
  if (!validation.ok) return validation;
  const pkg = validation.package;
  const targetSlug = sanitizePackageSlug(slugOverride) || pkg.capability.slug;
  const capability = {
    ...normalizeCapabilityDefinition({
      ...pkg.capability,
      slug: targetSlug,
      workflow: {
        ...(pkg.capability.workflow || {}),
        bundleId: "__WORKFLOW_BUNDLE_ID__",
        sharedPackage: {
          contentHash: validation.report.contentHash,
          importedFrom: pkg.capability.slug,
          packageName: pkg.package?.name || pkg.capability.name || pkg.capability.slug
        }
      },
      enabled: false
    }),
    enabled: false
  };
  return {
    ok: true,
    package: pkg,
    report: {
      ...validation.report,
      targetSlug,
      installEnabled: false,
      nextAction: "Import publishes the workflow source as a DB bundle, installs the capability disabled, then an admin can configure secrets/runners and enable it."
    },
    capability
  };
}

export function finalizeImportedCapability(planCapability, bundle) {
  return {
    ...planCapability,
    workflow: {
      ...(planCapability.workflow || {}),
      bundleId: bundle.id,
      sharedPackage: {
        ...(planCapability.workflow?.sharedPackage || {}),
        bundleSha256: bundle.sha256,
        bundleVersion: bundle.version
      }
    },
    enabled: false
  };
}

function packageCapabilityDefinition(capability) {
  const normalized = normalizeCapabilityDefinition({
    ...capability,
    enabled: false,
    workflow: stripLocalWorkflowBundleReference(capability.workflow || {})
  });
  return { ...normalized, enabled: false };
}

function stripLocalWorkflowBundleReference(workflow) {
  const cleaned = { ...workflow };
  delete cleaned.bundleId;
  delete cleaned.bundle_id;
  return cleaned;
}

function workflowPackageContentHash(pkg) {
  return createHash("sha256").update(stableJsonString(pkg)).digest("hex");
}

function declaredSecretNames(capability) {
  const values = [
    capability.workflow?.requiredSecrets,
    capability.workflow?.secrets,
    capability.workflow?.harness?.secrets
  ].flatMap((entry) => Array.isArray(entry) ? entry : []);
  return Array.from(new Set(values.map((name) => String(name || "").trim()).filter(Boolean))).sort();
}

function declaredHookProfiles(capability) {
  const hooks = capability.workflow?.hooks?.allowedProfiles || capability.workflow?.allowedHookProfiles || [];
  return Array.isArray(hooks) ? hooks.map((slug) => String(slug || "").trim()).filter(Boolean).sort() : [];
}

function workflowPackageReport(pkg, { actualSha, expectedHash, sizeBytes, valid }) {
  return {
    schema: pkg?.schema || "",
    valid,
    contentHash: expectedHash,
    declaredContentHash: pkg?.contentHash || "",
    capabilitySlug: pkg?.capability?.slug || "",
    capabilityName: pkg?.capability?.name || "",
    workflowSha256: actualSha,
    declaredWorkflowSha256: pkg?.workflow?.sha256 || "",
    sizeBytes,
    installEnabled: false,
    warnings: [
      "Imported workflow packages are installed disabled by default.",
      "Secret values are never included; configure required secrets on the target Hub before enabling."
    ]
  };
}

function sanitizePackageSlug(value) {
  const slug = String(value || "").trim();
  return SLUG_PATTERN.test(slug) ? slug : "";
}
