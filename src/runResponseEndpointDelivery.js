// Slice 2 of the per-run response-endpoint contract: actually deliver a
// terminal-state reply to whatever the caller registered when they created
// the run. Polling `GET /api/runs/:id` is still the canonical/fallback path;
// this delivery loop is a best-effort egress for callers that would rather
// be pushed than poll.
//
// Delivery is fire-and-forget from the terminal-state hooks in server.js,
// idempotent against repeated terminal updates, and bookkeeps every attempt
// (status, attempts, last_attempt_at, delivered_at, last_error) on the
// `run_response_endpoints` row created in slice 1. We NEVER echo the raw
// endpoint config — the caller-supplied URL/headers/chatId are read straight
// from the DB and used for outbound delivery only; events/audit get the
// redacted summary helpers from runResponseEndpoint.js.
//
// See specs/run-response-endpoints.md for the full contract.

import {
  addRunEvent,
  getRun,
  listArtifacts,
  listRunResponseEndpointsForRun,
  recordAudit,
  updateRunResponseEndpointDelivery
} from "./db.js";
import { env } from "./env.js";
import { now } from "./ids.js";
import {
  presentRunResponseEndpoint,
  safeResponseEndpointAuditDetail
} from "./runResponseEndpoint.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const ERROR_MAX_BYTES = 500;
const PAYLOAD_OUTPUT_KEY_LIMIT = 32;
const PAYLOAD_ARTIFACT_LIMIT = 50;

// Same set the validator masks in audit summaries; reused here so any error
// message we record never accidentally surfaces a header value.
const TOKEN_PATTERNS = [
  { re: /\b[Bb]earer\s+[A-Za-z0-9._-]{8,}\b/g, replace: "Bearer [redacted]" },
  { re: /\bshub_[A-Za-z0-9_-]{8,}\b/g, replace: "shub_[redacted]" },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, replace: "ghp_[redacted]" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+\b/g, replace: "[redacted-jwt]" }
];

function redact(value, max = ERROR_MAX_BYTES) {
  let text = String(value ?? "");
  for (const { re, replace } of TOKEN_PATTERNS) text = text.replace(re, replace);
  if (text.length > max) text = text.slice(0, max - 1) + "…";
  return text;
}

function safeError(message) {
  return redact(message, ERROR_MAX_BYTES);
}

// Build a sanitized, secret-free summary of the run's output: top-level key
// names + size only, never the raw values. Matches the contract from
// specs/run-response-endpoints.md ("safe summary / output metadata (size,
// top-level keys; not a full input echo and not secret-shaped values)").
function summarizeOutput(output) {
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

function describeArtifact(artifact, baseUrl) {
  return {
    id: artifact.id,
    name: artifact.name,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    deepLink: `/app#runs/${artifact.runId}/artifacts/${artifact.id}`,
    downloadUrl: `${baseUrl || ""}/api/artifacts/${artifact.id}/download`
  };
}

// Build the terminal-state delivery payload for a single run. This is shaped
// so a caller can act on the result without polling /api/runs/:id and
// without ever needing to see secret-shaped values from the run's input.
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
    error: run.status === "failed" ? safeError(run.error) : null,
    output: summarizeOutput(run.output),
    artifacts: artifacts.map((artifact) => describeArtifact(artifact, baseUrl)),
    links: {
      run: `/app#runs/${run.id}`,
      runDetail: `${baseUrl}/api/runs/${run.id}`,
      logs: `${baseUrl}/api/runs/${run.id}/logs`,
      events: `${baseUrl}/api/runs/${run.id}/events`,
      artifacts: `${baseUrl}/api/runs/${run.id}/artifacts`
    },
    deliveredAt: now()
  };
}

async function postJson(url, body, options, { fetchImpl, timeoutMs, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: options?.method || "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function deliverHttp(endpoint, payload, { fetchImpl, timeoutMs }) {
  const config = endpoint.config || {};
  const method = String(config.method || "POST").toUpperCase();
  // Slice 1 already validated method ∈ {POST, PUT}; reject anything else
  // defensively so a malformed row can't issue a GET we never planned for.
  if (method !== "POST" && method !== "PUT") {
    return { ok: false, error: `unsupported http method: ${method}` };
  }
  const result = await postJson(
    config.url,
    payload,
    { method },
    { fetchImpl, timeoutMs, headers: config.headers || {} }
  );
  if (result.ok) return { ok: true, status: result.status };
  if (result.status) {
    return { ok: false, status: result.status, error: `http delivery returned status ${result.status}` };
  }
  return { ok: false, error: `http delivery failed: ${safeError(result.error || "unknown error")}` };
}

function telegramTerminalMessage(run, payload, baseUrl) {
  const title = run.capabilityName || run.capabilitySlug || "Runyard run";
  const status = String(run.status || "terminal").toUpperCase();
  const link = `${baseUrl || ""}/app#runs/${run.id}`;
  const errorLine = payload.error ? `\nError: ${payload.error}` : "";
  const artifactLine = payload.artifacts.length
    ? `\nArtifacts: ${payload.artifacts.length}`
    : "";
  return `Runyard: ${title}\nRun ${run.id} → ${status}${errorLine}${artifactLine}\n${link}`;
}

async function deliverTelegram(endpoint, run, payload, { fetchImpl, timeoutMs, telegramBotToken, baseUrl }) {
  if (!telegramBotToken) {
    return {
      ok: false,
      error:
        "telegram delivery skipped: TELEGRAM_BOT_TOKEN (or SMITHERS_TELEGRAM_BOT_TOKEN) is not configured"
    };
  }
  const config = endpoint.config || {};
  const body = {
    chat_id: config.chatId,
    text: telegramTerminalMessage(run, payload, baseUrl),
    ...(config.threadId != null ? { message_thread_id: config.threadId } : {}),
    ...(config.parseMode ? { parse_mode: config.parseMode } : {})
  };
  const result = await postJson(
    `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
    body,
    { method: "POST" },
    { fetchImpl, timeoutMs }
  );
  if (result.ok) return { ok: true, status: result.status };
  if (result.status) {
    return { ok: false, status: result.status, error: `telegram delivery returned status ${result.status}` };
  }
  return { ok: false, error: `telegram delivery failed: ${safeError(result.error || "unknown error")}` };
}

export async function deliverRunResponseEndpoint(endpoint, run, payload, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const telegramBotToken = options.telegramBotToken ?? env.telegramBotToken;
  const baseUrl = options.baseUrl ?? env.baseUrl;
  if (endpoint.type === "http") {
    return deliverHttp(endpoint, payload, { fetchImpl, timeoutMs });
  }
  if (endpoint.type === "telegram") {
    return deliverTelegram(endpoint, run, payload, { fetchImpl, timeoutMs, telegramBotToken, baseUrl });
  }
  return { ok: false, error: `unknown response endpoint type: ${endpoint.type}` };
}

// Deliver every still-pending response endpoint attached to `runId`.
// - Skips runs that are not in a terminal state (polling stays canonical).
// - Skips endpoints whose `delivery_status` is already non-pending so a
//   repeated terminal update never produces a duplicate delivery.
// - Claims the row to `in_flight` before the outbound call so two
//   concurrent callers can't both deliver the same endpoint.
export async function deliverPendingForRun(runId, options = {}) {
  const run = getRun(runId);
  if (!run) return { delivered: [], skipped: "not-found" };
  if (!TERMINAL_STATUSES.has(run.status)) return { delivered: [], skipped: "not-terminal" };
  const endpoints = listRunResponseEndpointsForRun(runId).filter(
    (endpoint) => endpoint.deliveryStatus === "pending"
  );
  if (!endpoints.length) return { delivered: [], skipped: "none-pending" };
  const artifacts = listArtifacts({ runId });
  const baseUrl = options.baseUrl ?? env.baseUrl;
  const payload = buildRunResponseEndpointPayload(run, { artifacts, baseUrl });

  const results = [];
  for (const endpoint of endpoints) {
    // Mark the row in_flight first so a concurrent delivery call skips it.
    updateRunResponseEndpointDelivery(endpoint.id, {
      status: "in_flight",
      attempts: (endpoint.deliveryAttempts || 0) + 1,
      lastAttemptAt: now()
    });

    let result;
    try {
      result = await deliverRunResponseEndpoint(endpoint, run, payload, options);
    } catch (error) {
      result = { ok: false, error: safeError(error?.message || error) };
    }

    const finalUpdate = result.ok
      ? { status: "delivered", deliveredAt: now(), lastError: null }
      : { status: "failed", lastError: result.error || "delivery failed" };
    const updated = updateRunResponseEndpointDelivery(endpoint.id, finalUpdate);
    const auditDetail = safeResponseEndpointAuditDetail(updated);
    const presented = presentRunResponseEndpoint(updated);

    if (result.ok) {
      addRunEvent(runId, "run.response_endpoint.delivered", `Response endpoint delivered (${endpoint.type})`, {
        ...auditDetail,
        deliveryStatus: updated.deliveryStatus,
        deliveryAttempts: updated.deliveryAttempts,
        ...(result.status ? { httpStatus: result.status } : {})
      });
      recordAudit("system:response-endpoint", "run.response_endpoint.delivered", runId, {
        runId,
        ...auditDetail,
        deliveryStatus: updated.deliveryStatus
      });
    } else {
      addRunEvent(runId, "run.response_endpoint.delivery_failed", `Response endpoint delivery failed (${endpoint.type})`, {
        ...auditDetail,
        deliveryStatus: updated.deliveryStatus,
        deliveryAttempts: updated.deliveryAttempts,
        error: result.error,
        ...(result.status ? { httpStatus: result.status } : {})
      });
      recordAudit("system:response-endpoint", "run.response_endpoint.delivery_failed", runId, {
        runId,
        ...auditDetail,
        deliveryStatus: updated.deliveryStatus,
        error: result.error
      });
    }
    results.push({ endpointId: endpoint.id, type: endpoint.type, ok: result.ok, presented });
  }
  return { delivered: results };
}

// Fire-and-forget wrapper used from the terminal-state hooks. Returns the
// underlying promise so tests can await it; production callers ignore the
// return value and the promise's `.catch` keeps a crash from becoming an
// unhandled rejection.
export function scheduleRunResponseEndpointDelivery(runId, options = {}) {
  if (!runId) return Promise.resolve({ delivered: [], skipped: "no-run-id" });
  return deliverPendingForRun(runId, options).catch((error) => {
    try {
      addRunEvent(runId, "run.response_endpoint.delivery_failed", "Response endpoint delivery crashed", {
        error: safeError(error?.message || error)
      });
    } catch {
      /* best effort — don't mask the original crash */
    }
    return { delivered: [], error: safeError(error?.message || error) };
  });
}
