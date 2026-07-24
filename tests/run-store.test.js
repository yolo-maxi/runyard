import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRunStore } from "../src/runStore.js";

const runRow = {
  id: "run_1",
  capability_id: "cap_1",
  capability_slug: "hello",
  capability_name: "Hello",
  workflow_version: 1,
  runner_id: "runner_1",
  status: "queued",
  current_step: "queued",
  input: '{"topic":"test"}',
  output: null,
  error: null,
  capability_sha: "sha_1",
  parent_run_id: null,
  created_at: "2026-07-01T00:00:00.000Z",
  assigned_at: null,
  started_at: null,
  completed_at: null,
  updated_at: "2026-07-01T00:00:00.000Z"
};

const eventRow = {
  id: "evt_1",
  run_id: "run_1",
  type: "workflow.step",
  message: "Build",
  data: '{"step":"build"}',
  created_at: "2026-07-01T00:00:00.000Z"
};

function createHarness({ oneRows = [runRow], allRows = [runRow], visibleRunWhere = "visible = 1" } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createRunStore({
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
    now: () => "2026-07-01T00:00:00.000Z",
    visibleRunWhere
  });
  return { calls, store };
}

describe("run store", () => {
  it("loads, lists, and counts normalized runs through shared filters", () => {
    const { calls, store } = createHarness({ oneRows: [runRow, { count: 7 }] });

    assert.equal(store.getRun("run_1").input.topic, "test");
    assert.equal(store.listRuns({ status: "queued", q: "hello" })[0].capabilitySlug, "hello");
    assert.equal(store.countRuns({ status: "queued" }), 7);
    assert.ok(calls.some((call) => call.fn === "all" && call.sql.includes("visible = 1")));
  });

  it("lists capability versions and owner token ids", () => {
    const versionRow = {
      sha: "sha_1",
      runCount: 2,
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-02T00:00:00.000Z"
    };
    const { store } = createHarness({
      oneRows: [{ token_id: "tok_1" }],
      allRows: [versionRow]
    });

    assert.deepEqual(store.listCapabilityVersionsFromRuns("hello"), [{
      sha: "sha_1",
      runCount: 2,
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-02T00:00:00.000Z"
    }]);
    assert.deepEqual(store.listCapabilityVersionsFromRuns(""), []);
    assert.equal(store.runOwnerTokenId("run_1"), "tok_1");
    assert.equal(createHarness({ oneRows: [null] }).store.runOwnerTokenId("run_2"), null);
  });

  it("records and lists run events", () => {
    const { calls, store } = createHarness({ oneRows: [{ seq: 3 }], allRows: [eventRow] });

    const event = store.addRunEvent("run_1", "workflow.step", "Build", { step: "build" });

    assert.deepEqual(event, {
      id: "evt_1",
      runId: "run_1",
      type: "workflow.step",
      message: "Build",
      data: { step: "build" },
      seq: 3,
      createdAt: "2026-07-01T00:00:00.000Z"
    });
    assert.ok(calls.some((call) => call.fn === "run" && call.params.id === "evt_1"));
    assert.equal(store.listRunEvents("run_1")[0].type, "workflow.step");
  });

  it("pages run events after a seq cursor with a bounded limit", () => {
    const { calls, store } = createHarness({ allRows: [{ ...eventRow, seq: 5 }] });
    const page = store.listRunEventsAfter("run_1", 4, 200);
    assert.equal(page[0].seq, 5);
    const call = calls.find((c) => c.fn === "all" && c.sql.includes("seq > ?"));
    assert.deepEqual(call.params, ["run_1", 4, 200]);
  });
});
