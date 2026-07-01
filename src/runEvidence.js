export const SAFE_ARTIFACT_METADATA_KEYS = new Set([
  "generatedBy",
  "sourceNode",
  "sourceField",
  "kind",
  "schemaVersion",
  "smithersRunId"
]);

export function timestamp() {
  return new Date().toISOString();
}

export function msBetween(start, end) {
  const a = Date.parse(start || "");
  const b = Date.parse(end || "");
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

export function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function keysOf(value, max = 80) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, max);
}

export function valueShape(value, depth = 0) {
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

export function safeArtifactMetadata(metadata, { transform = (value) => value } = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => SAFE_ARTIFACT_METADATA_KEYS.has(key))
      .slice(0, 20)
      .map(([key, value]) => [transform(key, "key"), transform(value, "value")])
  );
}

export function artifactInventory(artifacts = [], options = {}) {
  const {
    generatedNames = [],
    limit = Infinity,
    transform = (value) => value
  } = options;
  const generated = new Set(generatedNames);
  return (artifacts || [])
    .filter((artifact) => !generated.has(artifact?.name))
    .map((artifact) => ({
      id: artifact.id || "",
      name: transform(artifact.name || "", "name"),
      mimeType: transform(artifact.mimeType || "", "mimeType"),
      sizeBytes: safeNumber(artifact.sizeBytes, 0),
      createdAt: artifact.createdAt || "",
      deepLink: artifact.deepLink || "",
      metadata: safeArtifactMetadata(artifact.metadata, { transform })
    }))
    .slice(0, limit);
}

export function topEventTypes(logSummary = {}, options = {}) {
  const {
    limit = 20,
    transform = (value) => value,
    count = (value) => value
  } = options;
  return (logSummary.types || []).slice(0, limit).map((entry) => ({
    key: transform(entry.key || "", "key"),
    count: count(entry.count),
    category: transform(entry.category || "", "category")
  }));
}

export function highlightEvents(logSummary = {}, options = {}) {
  const {
    limit = 20,
    includeId = true,
    transform = (value) => value
  } = options;
  return (logSummary.highlights || []).slice(-limit).map((event) => ({
    ...(includeId ? { id: event.id || "" } : {}),
    type: transform(event.type || "", "type"),
    category: transform(event.category || "", "category"),
    severity: transform(event.severity || "", "severity"),
    node: transform(event.node || "", "node"),
    message: transform(event.message || "", "message"),
    createdAt: event.createdAt || ""
  }));
}
