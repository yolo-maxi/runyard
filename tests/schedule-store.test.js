import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createScheduleStore } from "../src/scheduleStore.js";

const baseRow = {
  id: "sched_1",
  name: "Nightly",
  description: "",
  capability_slug: "hello",
  input: "{}",
  cron: "0 0 * * *",
  timezone: "UTC",
  run_at: null,
  enabled: 1,
  next_run_at: "2026-07-02T00:00:00.000Z",
  last_run_id: null,
  last_run_status: null,
  last_fired_at: null,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z"
};

function createHarness({ oneRows = [baseRow], allRows = [baseRow], changes = 1 } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createScheduleStore({
    all: (sql, params) => {
      calls.push({ fn: "all", sql, params });
      return allRows;
    },
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return rows.length ? rows.shift() : baseRow;
    },
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes };
    },
    id: (prefix) => `${prefix}_1`,
    now: () => "2026-07-01T00:00:00.000Z"
  });
  return { calls, store };
}

describe("schedule store", () => {
  it("creates, gets, and lists schedules through record helpers", () => {
    const { calls, store } = createHarness();

    const created = store.createSchedule({
      name: "Nightly",
      capabilitySlug: "hello",
      cron: "0 0 * * *",
      input: {}
    });
    const found = store.getSchedule("sched_1");
    const listed = store.listSchedules();

    assert.equal(created.id, "sched_1");
    assert.equal(found.id, "sched_1");
    assert.deepEqual(listed.map((schedule) => schedule.id), ["sched_1"]);
    assert.equal(calls.filter((call) => call.fn === "run").length, 1);
    assert.equal(calls.find((call) => call.fn === "run").params.id, "sched_1");
  });

  it("updates, toggles, deletes, and records fire results", () => {
    const { calls, store } = createHarness({ oneRows: [baseRow, baseRow, baseRow, baseRow, baseRow, baseRow] });

    assert.equal(store.updateSchedule("sched_1", { name: "Updated" }).id, "sched_1");
    assert.equal(store.setScheduleEnabled("sched_1", false).id, "sched_1");
    assert.equal(store.deleteSchedule("sched_1").id, "sched_1");
    assert.equal(store.recordScheduleFireResult("sched_1", "run_1", "queued").id, "sched_1");

    assert.equal(calls.filter((call) => call.fn === "run").length, 4);
  });

  it("returns null when updating or deleting a missing schedule", () => {
    const { calls, store } = createHarness({ oneRows: [null, null] });

    assert.equal(store.updateSchedule("missing", { name: "Updated" }), null);
    assert.equal(store.deleteSchedule("missing"), null);
    assert.equal(calls.some((call) => call.fn === "run"), false);
  });

  it("claims due schedules atomically and reports races", () => {
    const dueRow = {
      ...baseRow,
      next_run_at: "2026-07-01T00:00:00.000Z"
    };
    const ok = createHarness({ oneRows: [dueRow, baseRow], changes: 1 });
    const claimed = ok.store.claimScheduleFire(
      "sched_1",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    );
    assert.equal(claimed.ok, true);
    assert.equal(claimed.schedule.id, "sched_1");

    const raced = createHarness({ oneRows: [dueRow], changes: 0 });
    assert.deepEqual(raced.store.claimScheduleFire(
      "sched_1",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    ), { ok: false, reason: "raced" });
  });

  it("lists due schedules", () => {
    const { store } = createHarness();
    assert.deepEqual(store.listDueSchedules("2026-07-01T00:00:00.000Z").map((schedule) => schedule.id), ["sched_1"]);
  });
});
