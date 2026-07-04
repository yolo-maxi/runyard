import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHookProfileStore } from "../src/hookProfileStore.js";

function hookRow(overrides = {}) {
  return {
    id: "hook_1",
    slug: "static-publish",
    name: "Static publish",
    description: "",
    kind: "static-publish",
    config: JSON.stringify({ targetRoot: "/var/www/apps", allowedArtifactRoots: [] }),
    params: "[]",
    secret_names: "[]",
    allowed_capabilities: "[]",
    definition_hash: "",
    version: 1,
    enabled: 1,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function harness({ oneRows = [] } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createHookProfileStore({
    all: (sql, params) => {
      calls.push({ fn: "all", sql, params });
      return [hookRow()];
    },
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return rows.length ? rows.shift() : null;
    },
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: 1 };
    },
    id: (prefix) => `${prefix}_new`,
    now: () => "2026-07-04T00:00:00.000Z"
  });
  return { calls, store };
}

const VALID_INPUT = {
  slug: "static-publish",
  name: "Static publish",
  kind: "static-publish",
  config: { targetRoot: "/var/www/apps" }
};

describe("hook profile store", () => {
  it("refuses to persist invalid definitions", () => {
    const { calls, store } = harness();
    const result = store.upsertHookProfile({ slug: "bad", name: "Bad", kind: "nope" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 1);
    assert.equal(calls.filter((call) => call.fn === "run").length, 0, "invalid definitions never reach storage");
  });

  it("inserts a new profile at version 1", () => {
    const { calls, store } = harness({ oneRows: [null, hookRow({ definition_hash: "fresh" })] });
    const result = store.upsertHookProfile(VALID_INPUT);
    assert.equal(result.ok, true);
    const insert = calls.find((call) => call.fn === "run");
    assert.match(insert.sql, /INSERT INTO hook_profiles/);
    assert.equal(insert.params.version, 1);
    assert.equal(insert.params.id, "hook_new");
  });

  it("skips writes when the definition hash is unchanged", () => {
    const { store } = harness({ oneRows: [null] });
    // First insert computes the canonical hash for this definition.
    const probe = harness({ oneRows: [null, hookRow()] });
    probe.store.upsertHookProfile(VALID_INPUT);
    const hash = probe.calls.find((call) => call.fn === "run").params.definition_hash;

    const same = harness({ oneRows: [hookRow({ definition_hash: hash }), hookRow({ definition_hash: hash })] });
    same.store.upsertHookProfile(VALID_INPUT);
    assert.equal(same.calls.filter((call) => call.fn === "run").length, 0);
    assert.ok(store, "keep lint quiet");
  });

  it("bumps the version when the definition changes", () => {
    const { calls, store } = harness({
      oneRows: [hookRow({ definition_hash: "old", version: 3 }), hookRow({ version: 4 })]
    });
    const result = store.upsertHookProfile(VALID_INPUT);
    assert.equal(result.ok, true);
    const update = calls.find((call) => call.fn === "run");
    assert.match(update.sql, /UPDATE hook_profiles/);
    assert.equal(update.params.version, 4);
  });

  it("lists enabled profiles by default and normalizes rows", () => {
    const { calls, store } = harness();
    const profiles = store.listHookProfiles();
    assert.equal(profiles[0].slug, "static-publish");
    assert.deepEqual(profiles[0].config.allowedArtifactRoots, []);
    assert.match(calls[0].sql, /WHERE enabled = 1/);
    const all = harness();
    all.store.listHookProfiles({ includeDisabled: true });
    assert.doesNotMatch(all.calls[0].sql, /WHERE enabled = 1/);
  });
});
