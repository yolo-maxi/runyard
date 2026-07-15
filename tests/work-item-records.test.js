import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeWorkItem,
  normalizeWorkItemEvent,
  normalizeWorkItemRunSummaryRows,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES,
  workItemCreateRecord,
  workItemListQuery,
  workItemUpdateValues
} from "../src/workItemRecords.js";

const baseRow = {
  id: "wi_1",
  title: "Make pause/resume fully supported",
  description: "Ship the lifecycle",
  project: "runyard",
  type: "feature",
  status: "ready",
  priority: "high",
  owner: "fran",
  requester: "fran",
  acceptance_criteria: "Paused runs resume cleanly",
  next_action: "Cut the release",
  blocked_reason: "",
  due_at: null,
  created_by: "cli",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-02T00:00:00.000Z"
};

describe("work item record helpers", () => {
  it("declares the human-legible lifecycle", () => {
    assert.deepEqual(WORK_ITEM_STATUSES, [
      "intake", "triaged", "ready", "running", "waiting",
      "blocked", "review", "shipped", "accepted", "archived"
    ]);
    assert.ok(WORK_ITEM_TYPES.includes("bug"));
    assert.ok(WORK_ITEM_PRIORITIES.includes("urgent"));
    // A run failure class is never a ticket status: tickets stay human-legible.
    for (const notAStatus of ["failed", "budget_exceeded", "succeeded"]) {
      assert.ok(!WORK_ITEM_STATUSES.includes(notAStatus));
    }
  });

  it("normalizes stored work item rows", () => {
    assert.deepEqual(normalizeWorkItem(baseRow), {
      id: "wi_1",
      title: "Make pause/resume fully supported",
      description: "Ship the lifecycle",
      project: "runyard",
      type: "feature",
      status: "ready",
      priority: "high",
      owner: "fran",
      requester: "fran",
      acceptanceCriteria: "Paused runs resume cleanly",
      nextAction: "Cut the release",
      blockedReason: "",
      dueAt: null,
      createdBy: "cli",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z"
    });
    assert.equal(normalizeWorkItem(null), null);
  });

  it("builds create records with intake defaults", () => {
    const record = workItemCreateRecord({
      id: "wi_2",
      input: { title: "Fix the flaky gate" },
      timestamp: "2026-07-15T00:00:00.000Z"
    });
    assert.equal(record.status, "intake");
    assert.equal(record.type, "feature");
    assert.equal(record.priority, "normal");
    assert.equal(record.blocked_reason, "");
    assert.equal(record.due_at, null);
    assert.equal(record.created_at, "2026-07-15T00:00:00.000Z");
    assert.equal(record.updated_at, "2026-07-15T00:00:00.000Z");
  });

  it("builds list queries with filters and hides archived by default", () => {
    const bare = workItemListQuery();
    assert.match(bare.sql, /status <> 'archived'/);
    assert.deepEqual(bare.params, [200]);

    const filtered = workItemListQuery({
      status: "blocked", project: "runyard", owner: "fran", type: "bug", q: "pa%use", limit: 10
    });
    assert.match(filtered.sql, /status = \?/);
    assert.ok(!/status <> 'archived'/.test(filtered.sql));
    // Wildcards are stripped from the substring search.
    assert.deepEqual(filtered.params, ["blocked", "runyard", "fran", "bug", "%pause%", "%pause%", "%pause%", "%pause%", 10]);

    const archived = workItemListQuery({ includeArchived: true });
    assert.ok(!/archived/.test(archived.sql));
  });

  it("merges partial updates over the existing row, allowing explicit clears", () => {
    const values = workItemUpdateValues(baseRow, { status: "blocked", blockedReason: "waiting on creds", nextAction: "" }, "2026-07-16T00:00:00.000Z");
    // [title, description, project, type, status, priority, owner, requester,
    //  acceptance_criteria, next_action, blocked_reason, due_at, updated_at]
    assert.equal(values[0], baseRow.title);
    assert.equal(values[4], "blocked");
    assert.equal(values[9], "");
    assert.equal(values[10], "waiting on creds");
    assert.equal(values[11], null);
    assert.equal(values[12], "2026-07-16T00:00:00.000Z");

    const dueSet = workItemUpdateValues(baseRow, { dueAt: "2026-08-01T00:00:00.000Z" }, "t");
    assert.equal(dueSet[11], "2026-08-01T00:00:00.000Z");
    const dueCleared = workItemUpdateValues({ ...baseRow, due_at: "2026-08-01T00:00:00.000Z" }, { dueAt: null }, "t");
    assert.equal(dueCleared[11], null);
  });

  it("normalizes work item events", () => {
    assert.deepEqual(normalizeWorkItemEvent({
      id: "wie_1",
      work_item_id: "wi_1",
      type: "work_item.status_changed",
      message: "ready -> running",
      data: '{"from":"ready","to":"running"}',
      created_at: "2026-07-15T00:00:00.000Z"
    }), {
      id: "wie_1",
      workItemId: "wi_1",
      type: "work_item.status_changed",
      message: "ready -> running",
      data: { from: "ready", to: "running" },
      createdAt: "2026-07-15T00:00:00.000Z"
    });
  });

  it("folds per-status run summary rows into a per-item map", () => {
    const map = normalizeWorkItemRunSummaryRows([
      { work_item_id: "wi_1", status: "succeeded", count: 2, last_created_at: "2026-07-10T00:00:00.000Z" },
      { work_item_id: "wi_1", status: "paused", count: 1, last_created_at: "2026-07-12T00:00:00.000Z" },
      { work_item_id: "wi_2", status: "running", count: 1, last_created_at: "2026-07-11T00:00:00.000Z" }
    ]);
    assert.deepEqual(map.get("wi_1"), {
      total: 3,
      byStatus: { succeeded: 2, paused: 1 },
      lastRunAt: "2026-07-12T00:00:00.000Z"
    });
    assert.equal(map.get("wi_2").total, 1);
    assert.equal(map.get("missing"), undefined);
  });
});
