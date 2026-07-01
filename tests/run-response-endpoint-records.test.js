import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeRunResponseEndpoint,
  pendingRunResponseEndpointLimit,
  pendingRunResponseEndpointsQuery,
  runResponseEndpointDeliveryUpdateQuery,
  runResponseEndpointDeliveryUpdate,
  runResponseEndpointInsertQuery,
  runResponseEndpointLookupQuery,
  runResponseEndpointsForRunQuery,
  runResponseEndpointRecord
} from "../src/runResponseEndpointRecords.js";

describe("run response endpoint record helpers", () => {
  it("builds and normalizes persisted endpoint rows", () => {
    const record = runResponseEndpointRecord({
      id: "rres_1",
      runId: "run_1",
      type: "http",
      config: { url: "https://example.test/hook" },
      createdBy: "api",
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(record.config, '{"url":"https://example.test/hook"}');
    assert.deepEqual(normalizeRunResponseEndpoint(record), {
      id: "rres_1",
      runId: "run_1",
      type: "http",
      config: { url: "https://example.test/hook" },
      createdBy: "api",
      createdAt: "2026-01-01T00:00:00.000Z",
      deliveryStatus: "pending",
      deliveryAttempts: 0,
      lastAttemptAt: null,
      deliveredAt: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
  });

  it("validates required create and update identifiers", () => {
    assert.throws(() => runResponseEndpointRecord({
      id: "rres_1",
      runId: "",
      type: "http",
      timestamp: "now"
    }), /runId is required/);
    assert.throws(() => runResponseEndpointRecord({
      id: "rres_1",
      runId: "run_1",
      type: "",
      timestamp: "now"
    }), /type is required/);
    assert.throws(() => runResponseEndpointDeliveryUpdate({ id: "", timestamp: "now" }), /id is required/);
  });

  it("bounds pending delivery limits", () => {
    assert.equal(pendingRunResponseEndpointLimit("bad"), 100);
    assert.equal(pendingRunResponseEndpointLimit("-1"), 1);
    assert.equal(pendingRunResponseEndpointLimit("9999"), 1000);
    assert.equal(pendingRunResponseEndpointLimit("7"), 7);
  });

  it("builds run response endpoint read/write queries", () => {
    assert.deepEqual(runResponseEndpointInsertQuery(), {
      sql: `INSERT INTO run_response_endpoints
     (id, run_id, type, config, created_by, created_at, delivery_status,
      delivery_attempts, last_attempt_at, delivered_at, last_error, updated_at)
     VALUES ($id, $run_id, $type, $config, $created_by, $created_at, $delivery_status,
      $delivery_attempts, $last_attempt_at, $delivered_at, $last_error, $updated_at)`
    });
    assert.deepEqual(runResponseEndpointLookupQuery("rres_1"), {
      sql: "SELECT * FROM run_response_endpoints WHERE id = ?",
      params: ["rres_1"]
    });
    assert.deepEqual(runResponseEndpointsForRunQuery("run_1"), {
      sql: "SELECT * FROM run_response_endpoints WHERE run_id = ? ORDER BY created_at ASC",
      params: ["run_1"]
    });
    assert.deepEqual(pendingRunResponseEndpointsQuery("7"), {
      sql: "SELECT * FROM run_response_endpoints WHERE delivery_status = 'pending' ORDER BY created_at ASC LIMIT ?",
      params: [7]
    });
  });

  it("builds delivery update clauses and clamps attempt/error fields", () => {
    const update = runResponseEndpointDeliveryUpdate({
      id: "rres_1",
      timestamp: "2026-01-01T00:00:00.000Z",
      updates: {
        status: "failed",
        attempts: "-2",
        lastAttemptAt: "",
        deliveredAt: "2026-01-01T00:01:00.000Z",
        lastError: "e".repeat(2500)
      }
    });

    assert.deepEqual(update.sets, [
      "updated_at = $updated_at",
      "delivery_status = $delivery_status",
      "delivery_attempts = $delivery_attempts",
      "last_attempt_at = $last_attempt_at",
      "delivered_at = $delivered_at",
      "last_error = $last_error"
    ]);
    assert.equal(update.params.delivery_attempts, 0);
    assert.equal(update.params.last_attempt_at, null);
    assert.equal(update.params.last_error.length, 2000);
    assert.throws(() => runResponseEndpointDeliveryUpdate({
      id: "rres_1",
      timestamp: "now",
      updates: { status: "unknown" }
    }), /unknown status 'unknown'/);

    assert.deepEqual(runResponseEndpointDeliveryUpdateQuery({
      id: "rres_1",
      timestamp: "2026-01-01T00:00:00.000Z",
      updates: { status: "delivered", attempts: 2 }
    }), {
      sql: "UPDATE run_response_endpoints SET updated_at = $updated_at, delivery_status = $delivery_status, delivery_attempts = $delivery_attempts WHERE id = $id",
      params: {
        id: "rres_1",
        updated_at: "2026-01-01T00:00:00.000Z",
        delivery_status: "delivered",
        delivery_attempts: 2
      }
    });
  });
});
