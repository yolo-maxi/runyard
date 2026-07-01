import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCatalogStore } from "../src/catalogStore.js";

function createHarness({ existing = null, listed = [] } = {}) {
  const calls = [];
  const store = createCatalogStore({
    all: (sql, params) => {
      calls.push({ fn: "all", sql, params });
      return listed;
    },
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return existing;
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

describe("catalog store", () => {
  it("lists and gets editable catalog records", () => {
    const { calls, store } = createHarness({
      existing: {
        id: "agent_1",
        slug: "builder",
        name: "Builder",
        description: "Builds",
        instructions: "Ship it",
        updated_at: "now"
      },
      listed: [{
        id: "agent_1",
        slug: "builder",
        name: "Builder",
        description: "Builds",
        instructions: "Ship it",
        updated_at: "now"
      }]
    });

    assert.equal(store.getAgent("builder").slug, "builder");
    assert.deepEqual(store.listAgents("build").map((agent) => agent.slug), ["builder"]);
    assert.equal(calls[0].fn, "one");
    assert.equal(calls[1].fn, "all");
  });

  it("inserts new agents, skills, and knowledge with generated ids", () => {
    const { calls, store } = createHarness({
      listed: [
        { id: "agent_1", slug: "builder", name: "Builder", description: "", instructions: "", updated_at: "now" },
        { id: "skill_1", slug: "review", name: "Review", description: "", body: "", updated_at: "now" },
        { id: "know_1", slug: "notes", title: "Notes", body: "body", updated_at: "now" }
      ]
    });

    store.upsertAgent({ slug: "builder", name: "Builder" });
    store.upsertSkill({ slug: "review", name: "Review" });
    store.upsertKnowledge({ slug: "notes", title: "Notes", body: "body" });

    const writes = calls.filter((call) => call.fn === "run");
    assert.equal(writes.length, 3);
    assert.equal(writes[0].params.id, "agent_1");
    assert.equal(writes[1].params.id, "skill_1");
    assert.equal(writes[2].params.id, "know_1");
    assert.equal(writes[0].params.created_at, "2026-07-01T00:00:00.000Z");
  });

  it("updates existing records without generating replacement ids", () => {
    const { calls, store } = createHarness({
      existing: { id: "agent_existing", slug: "builder" },
      listed: [{ id: "agent_existing", slug: "builder", name: "Builder 2", description: "", instructions: "", updated_at: "now" }]
    });

    const updated = store.upsertAgent({ slug: "builder", name: "Builder 2" });

    assert.equal(updated.id, "agent_existing");
    const write = calls.find((call) => call.fn === "run");
    assert.ok(write);
    assert.equal(Object.hasOwn(write.params, "id"), false);
    assert.equal(Object.hasOwn(write.params, "created_at"), false);
  });
});
