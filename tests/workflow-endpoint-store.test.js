import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWorkflowEndpointStore } from "../src/workflowEndpointStore.js";

const endpointRow = {
  id: "wend_1",
  slug: "feedback",
  name: "Feedback",
  description: "",
  secret_hash: "hash_secret",
  capability_slug: "improve",
  project: "runyard",
  repo: "runyard",
  repo_dir: "",
  max_payload_bytes: 32768,
  rate_limit_count: 10,
  rate_limit_window_ms: 60000,
  dedupe_window_ms: 60000,
  config: "{}",
  enabled: 1,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z"
};

function createHarness({ oneRows = [endpointRow], allRows = [endpointRow] } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createWorkflowEndpointStore({
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
    now: () => "2026-07-01T00:00:00.000Z",
    hashToken: (token) => `hash:${token}`
  });
  return { calls, store };
}

describe("workflow endpoint store", () => {
  it("lists and gets endpoints without exposing secret hashes by default", () => {
    const { store } = createHarness();

    assert.equal(store.listWorkflowEndpoints()[0].slug, "feedback");
    assert.equal("secretHash" in store.getWorkflowEndpoint("feedback"), false);
    assert.equal(store.getWorkflowEndpoint("feedback", { includeSecretHash: true }).secretHash, "hash_secret");
  });

  it("inserts new endpoints with hashed secrets and generated ids", () => {
    const { calls, store } = createHarness({ oneRows: [null, endpointRow] });

    const endpoint = store.upsertWorkflowEndpoint({
      slug: "feedback",
      capabilitySlug: "improve"
    }, { secret: "secret" });

    assert.equal(endpoint.slug, "feedback");
    const write = calls.find((call) => call.fn === "run");
    assert.equal(write.params.id, "wend_1");
    assert.equal(write.params.secret_hash, "hash:secret");
  });

  it("updates existing endpoints and preserves their configured secret by default", () => {
    const { calls, store } = createHarness({ oneRows: [endpointRow, endpointRow] });

    store.upsertWorkflowEndpoint({
      slug: "feedback",
      capabilitySlug: "improve",
      name: "New name"
    });

    const write = calls.find((call) => call.fn === "run");
    assert.equal(Object.hasOwn(write.params, "id"), false);
    assert.equal(write.params.secret_hash, "hash_secret");
  });

  it("requires a secret for new endpoints", () => {
    const { store } = createHarness({ oneRows: [null] });

    assert.throws(
      () => store.upsertWorkflowEndpoint({ slug: "feedback", capabilitySlug: "improve" }),
      /workflow endpoint secret is required/
    );
  });

  it("records, counts, and finds endpoint invocations", () => {
    const invocationRow = {
      id: "weni_1",
      endpoint_id: "wend_1",
      endpoint_slug: "feedback",
      payload_hash: "sha256:abc",
      source_app: "mobile",
      source_user: "ada",
      source_session: "s1",
      run_id: "run_1",
      status: "queued",
      created_at: "2026-07-01T00:00:00.000Z"
    };
    const { calls, store } = createHarness({ oneRows: [{ count: 2 }, invocationRow] });

    assert.equal(store.countWorkflowEndpointInvocations("wend_1", "since"), 2);
    assert.equal(store.findRecentWorkflowEndpointInvocation("wend_1", "sha256:abc", "since").runId, "run_1");
    const recorded = store.recordWorkflowEndpointInvocation({
      endpoint: { id: "wend_1", slug: "feedback" },
      payloadHash: "sha256:abc",
      source: { app: "mobile", user: "ada", session: "s1" },
      runId: "run_1",
      status: "queued"
    });
    assert.equal(recorded.id, "weni_1");
    assert.equal(calls.filter((call) => call.fn === "run").length, 1);
  });
});
