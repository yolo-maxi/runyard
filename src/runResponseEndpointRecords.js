import { parseMaybeJson } from "./dbNormalization.js";

export const VALID_RESPONSE_ENDPOINT_DELIVERY_STATUSES = new Set([
  "pending",
  "in_flight",
  "delivered",
  "failed",
  "abandoned"
]);

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function normalizeRunResponseEndpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    config: parseMaybeJson(row.config, {}),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    deliveryStatus: row.delivery_status || "pending",
    deliveryAttempts: row.delivery_attempts || 0,
    lastAttemptAt: row.last_attempt_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

export function runResponseEndpointRecord({
  id,
  runId,
  type,
  config = {},
  createdBy = "",
  timestamp
}) {
  if (!runId) throw new Error("createRunResponseEndpoint: runId is required");
  if (!type) throw new Error("createRunResponseEndpoint: type is required");
  return {
    id,
    run_id: runId,
    type,
    config: jsonField(config || {}, {}),
    created_by: createdBy || "",
    created_at: timestamp,
    delivery_status: "pending",
    delivery_attempts: 0,
    last_attempt_at: null,
    delivered_at: null,
    last_error: null,
    updated_at: timestamp
  };
}

export function runResponseEndpointInsertQuery() {
  return {
    sql: `INSERT INTO run_response_endpoints
     (id, run_id, type, config, created_by, created_at, delivery_status,
      delivery_attempts, last_attempt_at, delivered_at, last_error, updated_at)
     VALUES ($id, $run_id, $type, $config, $created_by, $created_at, $delivery_status,
      $delivery_attempts, $last_attempt_at, $delivered_at, $last_error, $updated_at)`
  };
}

export function runResponseEndpointLookupQuery(id) {
  return {
    sql: "SELECT * FROM run_response_endpoints WHERE id = ?",
    params: [id]
  };
}

export function runResponseEndpointsForRunQuery(runId) {
  return {
    sql: "SELECT * FROM run_response_endpoints WHERE run_id = ? ORDER BY created_at ASC",
    params: [runId]
  };
}

export function pendingRunResponseEndpointsQuery(limit = 100) {
  return {
    sql: "SELECT * FROM run_response_endpoints WHERE delivery_status = 'pending' ORDER BY created_at ASC LIMIT ?",
    params: [pendingRunResponseEndpointLimit(limit)]
  };
}

export function pendingRunResponseEndpointLimit(limit = 100) {
  return Math.min(Math.max(Number(limit) || 100, 1), 1000);
}

export function runResponseEndpointDeliveryUpdate({ id, updates = {}, timestamp }) {
  if (!id) throw new Error("updateRunResponseEndpointDelivery: id is required");
  if (updates.status && !VALID_RESPONSE_ENDPOINT_DELIVERY_STATUSES.has(updates.status)) {
    throw new Error(`updateRunResponseEndpointDelivery: unknown status '${updates.status}'`);
  }
  const sets = ["updated_at = $updated_at"];
  const params = { id, updated_at: timestamp };
  if (updates.status != null) {
    sets.push("delivery_status = $delivery_status");
    params.delivery_status = updates.status;
  }
  if (updates.attempts != null) {
    sets.push("delivery_attempts = $delivery_attempts");
    params.delivery_attempts = Math.max(0, Math.floor(Number(updates.attempts) || 0));
  }
  if (updates.lastAttemptAt !== undefined) {
    sets.push("last_attempt_at = $last_attempt_at");
    params.last_attempt_at = updates.lastAttemptAt || null;
  }
  if (updates.deliveredAt !== undefined) {
    sets.push("delivered_at = $delivered_at");
    params.delivered_at = updates.deliveredAt || null;
  }
  if (updates.lastError !== undefined) {
    sets.push("last_error = $last_error");
    params.last_error = updates.lastError ? String(updates.lastError).slice(0, 2000) : null;
  }
  return { sets, params };
}

export function runResponseEndpointDeliveryUpdateQuery(update) {
  const { sets, params } = runResponseEndpointDeliveryUpdate(update);
  return {
    sql: `UPDATE run_response_endpoints SET ${sets.join(", ")} WHERE id = $id`,
    params
  };
}
