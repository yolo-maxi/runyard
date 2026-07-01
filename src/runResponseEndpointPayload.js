import { now } from "./ids.js";
import { redactText } from "./redaction.js";

const PAYLOAD_OUTPUT_KEY_LIMIT = 32;
const PAYLOAD_ARTIFACT_LIMIT = 50;
const ERROR_MAX_BYTES = 500;

export function redactResponseEndpointText(value, max = ERROR_MAX_BYTES) {
  return redactText(value, { max });
}

export function summarizeResponseOutput(output) {
  if (output == null) return null;
  if (typeof output !== "object" || Array.isArray(output)) {
    let text = "";
    try { text = JSON.stringify(output); } catch { text = String(output); }
    return {
      kind: Array.isArray(output) ? "array" : typeof output,
      sizeBytes: Buffer.byteLength(text || "", "utf8"),
      ...(Array.isArray(output) ? { length: output.length } : {})
    };
  }
  const allKeys = Object.keys(output);
  let text = "";
  try { text = JSON.stringify(output); } catch { text = ""; }
  return {
    kind: "object",
    keyCount: allKeys.length,
    keys: allKeys.slice(0, PAYLOAD_OUTPUT_KEY_LIMIT),
    sizeBytes: Buffer.byteLength(text, "utf8")
  };
}

export function responseArtifactDescriptor(artifact, baseUrl = "") {
  return {
    id: artifact.id,
    name: artifact.name,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    deepLink: `/app#runs/${artifact.runId}/artifacts/${artifact.id}`,
    downloadUrl: `${baseUrl}/api/artifacts/${artifact.id}/download`
  };
}

export function runResponseEndpointLinks(runId, baseUrl = "") {
  return {
    run: `/app#runs/${runId}`,
    runDetail: `${baseUrl}/api/runs/${runId}`,
    logs: `${baseUrl}/api/runs/${runId}/logs`,
    events: `${baseUrl}/api/runs/${runId}/events`,
    artifacts: `${baseUrl}/api/runs/${runId}/artifacts`
  };
}

export function buildRunResponseEndpointPayload(run, options = {}) {
  const artifacts = (options.artifacts || []).slice(0, PAYLOAD_ARTIFACT_LIMIT);
  const baseUrl = options.baseUrl || "";
  const completedAt = run.completedAt || null;
  const startedAt = run.startedAt || null;
  const durationMs = completedAt && startedAt
    ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
    : null;
  return {
    schemaVersion: "runyard.run.response.v1",
    runId: run.id,
    status: run.status,
    currentStep: run.currentStep || "",
    capability: {
      id: run.capabilityId || "",
      slug: run.capabilitySlug || "",
      name: run.capabilityName || "",
      workflowVersion: run.workflowVersion || null
    },
    timestamps: {
      createdAt: run.createdAt,
      startedAt,
      completedAt,
      durationMs
    },
    error: run.status === "failed" ? redactResponseEndpointText(run.error) : null,
    output: summarizeResponseOutput(run.output),
    artifacts: artifacts.map((artifact) => responseArtifactDescriptor(artifact, baseUrl)),
    links: runResponseEndpointLinks(run.id, baseUrl),
    deliveredAt: now()
  };
}
