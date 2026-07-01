import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCapabilityStore } from "../src/capabilityStore.js";
import {
  capabilityDefinitionHash,
  normalizeCapabilityDefinition
} from "../src/capabilityRecords.js";

function capabilityRow(overrides = {}) {
  return {
    id: "cap_1",
    slug: "hello",
    name: "Hello",
    description: "Says hello",
    category: "General",
    keywords: "[]",
    input_schema: "{}",
    output_schema: "{}",
    required_runner_tags: "[]",
    required_skills: "[]",
    required_agents: "[]",
    approval_policy: "{}",
    supervision: "{}",
    workflow: "{}",
    max_run_minutes: null,
    definition_hash: "",
    version: 1,
    enabled: 1,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function createHarness({ oneRows = [capabilityRow()], allRows = [capabilityRow()] } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createCapabilityStore({
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

describe("capability store", () => {
  it("lists and loads normalized capabilities", () => {
    const { store } = createHarness();

    assert.equal(store.listCapabilities({ q: "hel" })[0].slug, "hello");
    assert.equal(store.getCapability("hello").enabled, true);
  });

  it("inserts new capabilities and snapshots the first version", () => {
    const inserted = capabilityRow({ definition_hash: "hash" });
    const { calls, store } = createHarness({ oneRows: [null, inserted, inserted] });

    const capability = store.upsertCapability({
      slug: "hello",
      name: "Hello",
      description: "Says hello"
    });

    assert.equal(capability.slug, "hello");
    assert.ok(calls.some((call) => call.fn === "run" && call.params.id === "cap_1"));
    assert.ok(calls.some((call) => call.fn === "run" && call.params?.[0] === "capv_1"));
  });

  it("backfills missing definition hashes without creating a new version", () => {
    const definition = normalizeCapabilityDefinition({
      slug: "hello",
      name: "Hello",
      description: "Says hello"
    });
    const existing = capabilityRow({ definition_hash: "", version: 3 });
    const loaded = capabilityRow({
      definition_hash: capabilityDefinitionHash(definition),
      version: 3
    });
    const { calls, store } = createHarness({ oneRows: [existing, loaded] });

    assert.equal(store.upsertCapability(definition).version, 3);
    assert.ok(calls.some((call) => call.fn === "run" && call.sql === "UPDATE capabilities SET definition_hash = ? WHERE slug = ?"));
    assert.equal(calls.some((call) => call.fn === "run" && String(call.sql).startsWith("INSERT INTO capability_versions")), false);
  });

  it("updates changed capabilities and snapshots the new version", () => {
    const existing = capabilityRow({
      definition_hash: capabilityDefinitionHash(normalizeCapabilityDefinition({
        slug: "hello",
        name: "Hello",
        description: "Old"
      })),
      version: 2
    });
    const snapshotted = capabilityRow({
      definition_hash: "new-hash",
      version: 3,
      description: "New"
    });
    const { calls, store } = createHarness({ oneRows: [existing, snapshotted, snapshotted] });

    assert.equal(store.upsertCapability({
      slug: "hello",
      name: "Hello",
      description: "New"
    }).version, 3);
    assert.ok(calls.some((call) => call.fn === "run" && String(call.sql).startsWith("UPDATE capabilities SET")));
    assert.ok(calls.some((call) => call.fn === "run" && String(call.sql).startsWith("INSERT INTO capability_versions")));
  });
});
