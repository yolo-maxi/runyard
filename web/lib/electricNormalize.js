// Normalizers mapping Electric shape rows (snake_case columns, all values as
// strings, JSON columns as JSON text) into the camelCase shapes the RunYard UI
// already expects from the REST API. These mirror the server-side normalizers
// (src/runRecords.js, src/runnerRecords.js, etc.) so views are byte-compatible
// whether data arrives via Electric or the legacy REST fallback.
import { decorateEvent } from "./runEvents.js";

const OFFLINE_MS = 60_000;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toNum(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

export function normalizeRunRow(row) {
  return {
    id: row.id,
    capabilityId: row.capability_id,
    capabilitySlug: row.capability_slug,
    capabilityName: row.capability_name,
    workflowVersion: toNum(row.workflow_version, 1),
    runnerId: row.runner_id,
    status: row.status,
    currentStep: row.current_step,
    input: parseJson(row.input, {}),
    output: parseJson(row.output, null),
    error: row.error,
    capabilitySha: row.capability_sha || null,
    parentRunId: row.parent_run_id || null,
    attempt: toNum(row.attempt, 0),
    repairCount: toNum(row.repair_count, 0),
    createdAt: row.created_at,
    assignedAt: row.assigned_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

export function normalizeRunEventRow(row) {
  return decorateEvent({
    id: row.id,
    runId: row.run_id,
    type: row.type,
    message: row.message,
    data: parseJson(row.data, {}),
    createdAt: row.created_at
  });
}

export function normalizeRunnerRow(row) {
  const capacity = Math.max(1, toNum(row.capacity, 1));
  const activeRuns = Math.min(capacity, Math.max(0, toNum(row.active_runs, 0)));
  const last = row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : NaN;
  const online = !Number.isNaN(last) && Date.now() - last <= OFFLINE_MS;
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    version: row.version,
    tags: parseJson(row.tags, []),
    status: online ? (row.status === "offline" ? "online" : row.status) : "offline",
    online,
    currentRunId: row.current_run_id,
    capacity,
    activeRuns,
    availableSlots: Math.max(0, capacity - activeRuns),
    authHealth: parseJson(row.auth_health, null),
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at
  };
}

export function normalizeCapabilityRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    keywords: parseJson(row.keywords, []),
    version: toNum(row.version, 1),
    enabled: toNum(row.enabled, 1) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function normalizeApprovalRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    title: row.title,
    description: row.description,
    requestedBy: row.requested_by,
    payload: parseJson(row.payload, {}),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    decision: row.decision,
    comment: row.comment
  };
}

export function normalizeArtifactRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: toNum(row.size_bytes, 0),
    path: row.path,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at
  };
}
