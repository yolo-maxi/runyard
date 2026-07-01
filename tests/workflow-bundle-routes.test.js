import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWorkflowBundleHandlers } from "../src/workflowBundleRoutes.js";
import { createWorkflowBundleStore } from "../src/workflowBundleStore.js";
import { MAX_WORKFLOW_BUNDLE_BYTES } from "../src/workflowSource.js";
import { mockResponse as response } from "./response.js";

// Route tests run against the real store on an in-memory row set, so the
// publish path (cap check -> versioning -> insert) is exercised end to end.
function harness() {
  const rows = [];
  const audits = [];
  let sequence = 0;
  const store = createWorkflowBundleStore({
    all: (sql, params) => {
      let matched = rows;
      if (sql.includes("WHERE capability_slug = ?")) {
        matched = rows.filter((row) => row.capability_slug === params[0]);
      }
      return [...matched].sort((a, b) => b.version - a.version);
    },
    one: (sql, params) => {
      if (sql.includes("MAX(version)")) {
        const versions = rows.filter((row) => row.capability_slug === params[0]).map((row) => row.version);
        return { version: versions.length ? Math.max(...versions) : null };
      }
      return rows.find((row) => row.id === params[0]) || null;
    },
    run: (sql, params) => {
      rows.push({ ...params });
      return { changes: 1 };
    },
    id: (prefix) => `${prefix}_${(sequence += 1)}`,
    now: () => "2026-07-01T00:00:00.000Z"
  });
  const handlers = createWorkflowBundleHandlers({
    getWorkflowBundle: store.getWorkflowBundle,
    listWorkflowBundles: store.listWorkflowBundles,
    publishWorkflowBundle: store.publishWorkflowBundle,
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail })
  });
  return { audits, handlers, rows };
}

function req({ body = {}, params = {}, query = {} } = {}) {
  return { body, params, query, headers: {}, token: { id: "tok_1", name: "operator", scopes: ["admin"] } };
}

describe("workflow bundle routes", () => {
  it("publishes a small bundle, storing size, hash, and code, and audits it", () => {
    const { audits, handlers, rows } = harness();
    const code = "// smithers-display-name: Hello\nexport default null;\n";
    const res = response();
    handlers.publishWorkflowBundle(req({ body: { capabilitySlug: "hello", code, language: "tsx" } }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.bundle.capabilitySlug, "hello");
    assert.equal(res.body.bundle.version, 1);
    assert.equal(res.body.bundle.sizeBytes, Buffer.byteLength(code, "utf8"));
    assert.match(res.body.bundle.sha256, /^[0-9a-f]{64}$/);
    assert.equal(rows[0].code, code);
    assert.equal(audits[0].action, "workflow_bundle.published");
    assert.equal(audits[0].detail.sizeBytes, res.body.bundle.sizeBytes);
  });

  it("rejects an oversized bundle with 413 before storage", () => {
    const { audits, handlers, rows } = harness();
    const res = response();
    handlers.publishWorkflowBundle(req({
      body: { capabilitySlug: "hello", code: "x".repeat(MAX_WORKFLOW_BUNDLE_BYTES + 1) }
    }), res);

    assert.equal(res.statusCode, 413);
    assert.equal(res.body.sizeBytes, MAX_WORKFLOW_BUNDLE_BYTES + 1);
    assert.equal(res.body.maxWorkflowBundleBytes, MAX_WORKFLOW_BUNDLE_BYTES);
    assert.match(res.body.error, /500 KB/);
    assert.equal(rows.length, 0);
    assert.equal(audits.length, 0);
  });

  it("rejects invalid publish payloads with 400", () => {
    const { handlers } = harness();
    const res = response();
    handlers.publishWorkflowBundle(req({ body: { capabilitySlug: "hello" } }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /code is required/);
  });

  it("versions repeat publishes and serves get/list", () => {
    const { handlers } = harness();
    handlers.publishWorkflowBundle(req({ body: { capabilitySlug: "hello", code: "v1" } }), response());
    const second = response();
    handlers.publishWorkflowBundle(req({ body: { capabilitySlug: "hello", code: "v2" } }), second);
    assert.equal(second.body.bundle.version, 2);

    const got = response();
    handlers.getWorkflowBundle(req({ params: { id: second.body.bundle.id } }), got);
    assert.equal(got.body.bundle.code, "v2");
    assert.equal(got.body.bundle.version, 2);

    const listed = response();
    handlers.listWorkflowBundles(req({ query: { capability: "hello" } }), listed);
    assert.equal(listed.body.bundles.length, 2);
    assert.equal(listed.body.bundles[0].version, 2);
    assert.equal(listed.body.bundles[0].code, undefined);

    const missing = response();
    handlers.getWorkflowBundle(req({ params: { id: "wfb_nope" } }), missing);
    assert.equal(missing.statusCode, 404);
  });
});
