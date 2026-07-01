import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { createWorkflowBundleStore } from "../src/workflowBundleStore.js";
import { MAX_WORKFLOW_BUNDLE_BYTES } from "../src/workflowSource.js";

function bundleRow(overrides = {}) {
  return {
    id: "wfb_1",
    capability_slug: "hello",
    version: 1,
    language: "tsx",
    code: "export default null;\n",
    size_bytes: 21,
    sha256: "abc",
    created_by: "operator",
    created_at: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function createHarness({ oneRows = [], allRows = [] } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createWorkflowBundleStore({
    all: (sql, params) => {
      calls.push({ fn: "all", sql, params });
      return allRows;
    },
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return rows.length ? rows.shift() : null;
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

describe("workflow bundle store", () => {
  it("publishes a bundle with size, sha256, and version 1 for a new slug", () => {
    const code = "// smithers-display-name: Hello\nexport default null;\n";
    const { calls, store } = createHarness({ oneRows: [{ version: null }] });

    const bundle = store.publishWorkflowBundle({
      capabilitySlug: "hello",
      code,
      language: ".TSX",
      createdBy: "operator"
    });

    assert.equal(bundle.id, "wfb_1");
    assert.equal(bundle.capabilitySlug, "hello");
    assert.equal(bundle.version, 1);
    assert.equal(bundle.language, "tsx");
    assert.equal(bundle.sizeBytes, Buffer.byteLength(code, "utf8"));
    assert.equal(bundle.sha256, createHash("sha256").update(code, "utf8").digest("hex"));
    assert.equal(bundle.createdBy, "operator");
    assert.equal(bundle.code, undefined, "publish response is metadata-only");

    const insert = calls.find((call) => call.fn === "run");
    assert.match(insert.sql, /^INSERT INTO workflow_bundles/);
    assert.equal(insert.params.code, code);
    assert.equal(insert.params.size_bytes, bundle.sizeBytes);
    assert.equal(insert.params.sha256, bundle.sha256);
  });

  it("publishes the next version instead of editing bytes in place", () => {
    const { calls, store } = createHarness({ oneRows: [{ version: 3 }] });

    const bundle = store.publishWorkflowBundle({ capabilitySlug: "hello", code: "v4" });

    assert.equal(bundle.version, 4);
    const writes = calls.filter((call) => call.fn === "run");
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /^INSERT INTO workflow_bundles/);
    assert.doesNotMatch(writes[0].sql, /UPDATE/);
  });

  it("rejects oversized bundles before anything reaches the DB", () => {
    const { calls, store } = createHarness();
    const code = "x".repeat(MAX_WORKFLOW_BUNDLE_BYTES + 1);

    assert.throws(
      () => store.publishWorkflowBundle({ capabilitySlug: "hello", code }),
      (error) => {
        assert.equal(error.code, "workflow_bundle_too_large");
        assert.equal(error.sizeBytes, MAX_WORKFLOW_BUNDLE_BYTES + 1);
        assert.equal(error.maxWorkflowBundleBytes, MAX_WORKFLOW_BUNDLE_BYTES);
        assert.match(error.message, /500 KB/);
        assert.match(error.message, new RegExp(`is ${MAX_WORKFLOW_BUNDLE_BYTES + 1} bytes`));
        return true;
      }
    );
    assert.equal(calls.filter((call) => call.fn === "run").length, 0);
  });

  it("accepts a bundle exactly at the cap", () => {
    const { store } = createHarness({ oneRows: [{ version: null }] });
    const bundle = store.publishWorkflowBundle({
      capabilitySlug: "hello",
      code: "x".repeat(MAX_WORKFLOW_BUNDLE_BYTES)
    });
    assert.equal(bundle.sizeBytes, MAX_WORKFLOW_BUNDLE_BYTES);
  });

  it("requires a sane capability slug and non-empty code", () => {
    const { calls, store } = createHarness();
    assert.throws(() => store.publishWorkflowBundle({ capabilitySlug: "", code: "x" }), /capabilitySlug is required/);
    assert.throws(() => store.publishWorkflowBundle({ capabilitySlug: "../etc", code: "x" }), /capabilitySlug is required/);
    assert.throws(() => store.publishWorkflowBundle({ capabilitySlug: "hello", code: "   " }), /code is required/);
    assert.throws(() => store.publishWorkflowBundle({ capabilitySlug: "hello", code: 42 }), /code is required/);
    assert.equal(calls.filter((call) => call.fn === "run").length, 0);
  });

  it("loads bundles with code by default and lists metadata without code", () => {
    const { store: getStore } = createHarness({ oneRows: [bundleRow()] });
    const loaded = getStore.getWorkflowBundle("wfb_1");
    assert.equal(loaded.code, "export default null;\n");
    assert.equal(loaded.sizeBytes, 21);

    const { store: listStore } = createHarness({ allRows: [bundleRow(), bundleRow({ id: "wfb_2", version: 2 })] });
    const listed = listStore.listWorkflowBundles({ capabilitySlug: "hello" });
    assert.equal(listed.length, 2);
    assert.equal(listed[0].code, undefined);
    assert.equal(listed[0].sha256, "abc");
  });
});
