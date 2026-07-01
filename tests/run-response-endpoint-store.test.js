import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRunResponseEndpointStore } from "../src/runResponseEndpointStore.js";

const endpointRow = {
  id: "rres_1",
  run_id: "run_1",
  type: "http",
  config: '{"url":"https://example.test/hook"}',
  created_by: "api",
  created_at: "2026-07-01T00:00:00.000Z",
  delivery_status: "pending",
  delivery_attempts: 0,
  last_attempt_at: null,
  delivered_at: null,
  last_error: null,
  updated_at: "2026-07-01T00:00:00.000Z"
};

function createHarness({ oneRows = [endpointRow], allRows = [endpointRow] } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createRunResponseEndpointStore({
    all: (sql, params) => {
      calls.push({ fn: "all", sql, params });
      return allRows;
    },
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return rows.length ? rows.shift() : endpointRow;
    },
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: 1 };
    },
    id: (prefix) => `${prefix}_1`,
    now: () => "2026-07-01T00:00:00.000Z"
  });
  return { calls, store };
}

describe("run response endpoint store", () => {
  it("creates endpoints and returns the stored row", () => {
    const { calls, store } = createHarness();

    const endpoint = store.createRunResponseEndpoint({
      runId: "run_1",
      type: "http",
      config: { url: "https://example.test/hook" },
      createdBy: "api"
    });

    assert.equal(endpoint.id, "rres_1");
    const write = calls.find((call) => call.fn === "run");
    assert.equal(write.params.id, "rres_1");
    assert.equal(write.params.run_id, "run_1");
    assert.equal(write.params.delivery_status, "pending");
  });

  it("lists run-scoped and pending endpoints", () => {
    const { store } = createHarness();

    assert.deepEqual(store.listRunResponseEndpointsForRun("run_1").map((endpoint) => endpoint.id), ["rres_1"]);
    assert.deepEqual(store.listPendingRunResponseEndpoints(5).map((endpoint) => endpoint.id), ["rres_1"]);
    assert.deepEqual(store.listRunResponseEndpointsForRun(""), []);
  });

  it("updates delivery fields and reloads the endpoint", () => {
    const delivered = {
      ...endpointRow,
      delivery_status: "delivered",
      delivery_attempts: 1,
      delivered_at: "2026-07-01T00:01:00.000Z",
      updated_at: "2026-07-01T00:01:00.000Z"
    };
    const { calls, store } = createHarness({ oneRows: [delivered] });

    const endpoint = store.updateRunResponseEndpointDelivery("rres_1", {
      status: "delivered",
      attempts: 1,
      deliveredAt: "2026-07-01T00:01:00.000Z"
    });

    assert.equal(endpoint.deliveryStatus, "delivered");
    const write = calls.find((call) => call.fn === "run");
    assert.equal(write.params.id, "rres_1");
    assert.equal(write.params.delivery_status, "delivered");
    assert.equal(write.params.delivery_attempts, 1);
  });
});
