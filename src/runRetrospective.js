export const RUN_RETROSPECTIVE_ARTIFACT_NAME = "run-retrospective.json";
export const RUN_RETROSPECTIVE_SCHEMA_VERSION = "smithers.hub.run-retrospective.v1";
const GENERATED_RUN_ARTIFACT_NAMES = new Set([RUN_RETROSPECTIVE_ARTIFACT_NAME, "run-obstruction-analysis.json"]);

const SAFE_ARTIFACT_METADATA_KEYS = new Set([
  "generatedBy",
  "sourceNode",
  "sourceField",
  "kind",
  "schemaVersion",
  "smithersRunId"
]);

function timestamp() {
  return new Date().toISOString();
}

function msBetween(start, end) {
  const a = Date.parse(start || "");
  const b = Date.parse(end || "");
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

function keysOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 80);
}

function valueShape(value, depth = 0) {
  if (value == null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: depth < 1 && value.length ? valueShape(value[0], depth + 1) : null
    };
  }
  if (typeof value === "object") {
    const keys = keysOf(value);
    return {
      type: "object",
      keys,
      fields:
        depth < 1
          ? Object.fromEntries(keys.slice(0, 24).map((key) => [key, valueShape(value[key], depth + 1)]))
          : {}
    };
  }
  return { type: typeof value };
}

function safeArtifactMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => SAFE_ARTIFACT_METADATA_KEYS.has(key))
      .slice(0, 20)
  );
}

function artifactInventory(artifacts = []) {
  return (artifacts || [])
    .filter((artifact) => !GENERATED_RUN_ARTIFACT_NAMES.has(artifact?.name))
    .map((artifact) => ({
      id: artifact.id || "",
      name: artifact.name || "",
      mimeType: artifact.mimeType || "",
      sizeBytes: Number(artifact.sizeBytes || 0),
      createdAt: artifact.createdAt || "",
      deepLink: artifact.deepLink || "",
      metadata: safeArtifactMetadata(artifact.metadata)
    }));
}

function topEventTypes(logSummary = {}) {
  return (logSummary.types || []).slice(0, 20).map((entry) => ({
    key: entry.key,
    count: entry.count,
    category: entry.category
  }));
}

function highlightEvents(logSummary = {}) {
  return (logSummary.highlights || []).slice(-20).map((event) => ({
    id: event.id || "",
    type: event.type || "",
    category: event.category || "",
    severity: event.severity || "",
    node: event.node || "",
    message: event.message || "",
    createdAt: event.createdAt || ""
  }));
}

function diagnosticSummary(diagnostics) {
  if (!diagnostics) return null;
  return {
    status: diagnostics.status || "",
    headline: diagnostics.headline || "",
    reason: diagnostics.reason || "",
    failedStep: diagnostics.failedStep || "",
    failureType: diagnostics.failureType || "",
    failedAt: diagnostics.failedAt || "",
    cancelledBy: diagnostics.cancelledBy || "",
    approval: diagnostics.approval || null,
    diagnosticArtifacts: (diagnostics.artifacts || []).map((artifact) => ({
      id: artifact.id || "",
      name: artifact.name || "",
      mimeType: artifact.mimeType || "",
      deepLink: artifact.deepLink || ""
    }))
  };
}

export function buildRunRetrospectiveArtifact({
  run,
  capability = null,
  artifacts = [],
  logSummary = {},
  diagnostics = null,
  generatedAt = timestamp()
} = {}) {
  const inventory = artifactInventory(artifacts);
  const content = {
    schemaVersion: RUN_RETROSPECTIVE_SCHEMA_VERSION,
    generatedAt,
    generatedBy: "smithers-hub",
    purpose: "Lightweight run evidence for later batch knowledge analysis.",
    policy: {
      artifactOnly: true,
      autoMutations: false,
      mutatedSoftAssets: []
    },
    run: {
      id: run?.id || "",
      status: run?.status || "",
      title: run?.title || "",
      description: run?.description || "",
      capabilitySlug: run?.capabilitySlug || "",
      capabilityName: run?.capabilityName || "",
      workflowVersion: run?.workflowVersion ?? null,
      runnerId: run?.runnerId || "",
      currentStep: run?.currentStep || "",
      createdAt: run?.createdAt || "",
      assignedAt: run?.assignedAt || "",
      startedAt: run?.startedAt || "",
      completedAt: run?.completedAt || "",
      durationMs: run?.durationMs ?? msBetween(run?.startedAt || run?.createdAt, run?.completedAt),
      deepLink: run?.deepLink || ""
    },
    workflow: capability
      ? {
          slug: capability.slug || run?.capabilitySlug || "",
          name: capability.name || run?.capabilityName || "",
          version: capability.version ?? run?.workflowVersion ?? null,
          engine: capability.workflow?.engine || "",
          entry: capability.workflow?.entry || capability.workflow?.file || "",
          requiredRunnerTags: capability.requiredRunnerTags || [],
          requiredSkills: capability.requiredSkills || [],
          requiredAgents: capability.requiredAgents || [],
          deepLink: capability.deepLink || ""
        }
      : null,
    timing: {
      queuedMs: msBetween(run?.createdAt, run?.assignedAt || run?.startedAt),
      executionMs: msBetween(run?.startedAt, run?.completedAt),
      totalMs: msBetween(run?.createdAt, run?.completedAt)
    },
    outcome: {
      status: run?.status || "",
      succeeded: run?.status === "succeeded",
      diagnostics: diagnosticSummary(diagnostics)
    },
    evidence: {
      eventTotals: logSummary.totals || { events: 0, highlights: 0, errors: 0, warnings: 0 },
      eventCategories: logSummary.categories || [],
      eventSeverities: logSummary.severities || [],
      topEventTypes: topEventTypes(logSummary),
      highlightEvents: highlightEvents(logSummary),
      artifactInventory: inventory,
      outputShape: valueShape(run?.output)
    },
    notes: [
      "This artifact is generated by the Hub at run terminalization.",
      "It does not include full raw input objects, raw artifact contents, or raw output values.",
      "It did not modify workflows, skills, agents, knowledge, prompts, or other soft assets."
    ]
  };

  return {
    name: RUN_RETROSPECTIVE_ARTIFACT_NAME,
    mimeType: "application/json",
    content: JSON.stringify(content, null, 2),
    metadata: {
      generatedBy: "smithers-hub",
      kind: "run-retrospective",
      schemaVersion: RUN_RETROSPECTIVE_SCHEMA_VERSION
    }
  };
}
