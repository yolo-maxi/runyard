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
import { buildRunResponseEndpointPayload } from "./runResponseEndpointPayload.js";
import {
  presentRunResponseEndpoint,
  safeResponseEndpointAuditDetail
} from "./runResponseEndpoint.js";
import {
  deliverResponseEndpointTransport,
  safeResponseEndpointError
} from "./runResponseEndpointTransports.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

function safeError(message) {
  return safeResponseEndpointError(message);
}

export async function deliverRunResponseEndpoint(endpoint, run, payload, options = {}) {
  return deliverResponseEndpointTransport(endpoint, run, payload, options);
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
