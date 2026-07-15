import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { createWorkItemStore } from "../src/workItemStore.js";

// Real in-memory SQLite so the record SQL is exercised for real, including
// the runs.work_item_id link column (added by migration on live installs and
// by DB_SCHEMA_SQL on fresh ones).
function createHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DB_SCHEMA_SQL);
  const one = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params));
  const all = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params));
  const run = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params));
  let counter = 0;
  const clock = { value: 0 };
  const store = createWorkItemStore({
    all,
    one,
    run,
    id: (prefix) => `${prefix}_${++counter}`,
    now: () => new Date(1750000000000 + (clock.value += 1000)).toISOString()
  });
  const insertRun = (id, status = "queued", workItemId = null) => {
    run("INSERT INTO capabilities (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", ["cap_1", "hello", "Hello", "t", "t"]);
    run(
      `INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version, status, input, work_item_id, created_at, updated_at)
       VALUES (?, 'cap_1', 'hello', 'Hello', 1, ?, '{}', ?, ?, ?)`,
      [id, status, workItemId, new Date(1750000000000 + counter).toISOString(), "t"]
    );
  };
  return { db, store, one, all, insertRun };
}

describe("work item store", () => {
  it("creates a work item with defaults and records a created event", () => {
    const { store } = createHarness();
    const item = store.createWorkItem({ title: "Ship the board", createdBy: "test" });
    assert.match(item.id, /^wi_/);
    assert.equal(item.status, "intake");
    assert.equal(item.priority, "normal");
    const events = store.listWorkItemEvents(item.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "work_item.created");
    assert.equal(events[0].data.actor, "test");
  });

  it("lists with filters and hides archived by default", () => {
    const { store } = createHarness();
    const a = store.createWorkItem({ title: "Alpha", project: "p1", owner: "fran", type: "bug" });
    store.createWorkItem({ title: "Beta", project: "p2" });
    const archived = store.createWorkItem({ title: "Old", status: "archived" });

    assert.deepEqual(store.listWorkItems().map((item) => item.title).sort(), ["Alpha", "Beta"]);
    assert.equal(store.listWorkItems({ includeArchived: true }).length, 3);
    assert.deepEqual(store.listWorkItems({ status: "archived" }).map((i) => i.id), [archived.id]);
    assert.deepEqual(store.listWorkItems({ project: "p1" }).map((i) => i.id), [a.id]);
    assert.deepEqual(store.listWorkItems({ owner: "fran" }).map((i) => i.id), [a.id]);
    assert.deepEqual(store.listWorkItems({ type: "bug" }).map((i) => i.id), [a.id]);
    assert.deepEqual(store.listWorkItems({ q: "alph" }).map((i) => i.id), [a.id]);
  });

  it("updates fields and records a status_changed event for lane moves", () => {
    const { store } = createHarness();
    const item = store.createWorkItem({ title: "Ship it" });
    const moved = store.updateWorkItem(item.id, { status: "blocked", blockedReason: "waiting on creds" }, { actor: "fran" });
    assert.equal(moved.status, "blocked");
    assert.equal(moved.blockedReason, "waiting on creds");
    const events = store.listWorkItemEvents(item.id);
    assert.equal(events[0].type, "work_item.status_changed");
    assert.deepEqual(events[0].data, { from: "intake", to: "blocked", actor: "fran" });

    const edited = store.updateWorkItem(item.id, { nextAction: "Ping ops" });
    assert.equal(edited.nextAction, "Ping ops");
    assert.equal(store.listWorkItemEvents(item.id)[0].type, "work_item.updated");
    assert.equal(store.updateWorkItem("wi_missing", { title: "x" }), null);
  });

  it("links and unlinks runs, moving a run between tickets with events on both", () => {
    const { store, insertRun, one } = createHarness();
    const first = store.createWorkItem({ title: "First" });
    const second = store.createWorkItem({ title: "Second" });
    insertRun("run_1", "running");

    const linked = store.linkRunToWorkItem(first.id, "run_1");
    assert.equal(linked.ok, true);
    assert.equal(one("SELECT work_item_id FROM runs WHERE id = ?", ["run_1"]).work_item_id, first.id);
    assert.deepEqual(store.listWorkItemRuns(first.id).map((run) => run.id), ["run_1"]);
    assert.equal(store.listWorkItemRuns(first.id)[0].workItemId, first.id);

    // Idempotent relink.
    assert.equal(store.linkRunToWorkItem(first.id, "run_1").idempotent, true);

    // Moving to another ticket records an unlink event on the old one.
    assert.equal(store.linkRunToWorkItem(second.id, "run_1").ok, true);
    assert.equal(store.listWorkItemEvents(first.id)[0].type, "work_item.run_unlinked");
    assert.equal(store.listWorkItemEvents(second.id)[0].type, "work_item.run_linked");

    // Unlink honesty: wrong ticket → 409, missing run/item → 404.
    assert.equal(store.unlinkRunFromWorkItem(first.id, "run_1").code, 409);
    assert.equal(store.linkRunToWorkItem("wi_missing", "run_1").code, 404);
    assert.equal(store.linkRunToWorkItem(first.id, "run_missing").code, 404);
    const unlinked = store.unlinkRunFromWorkItem(second.id, "run_1");
    assert.equal(unlinked.ok, true);
    assert.equal(one("SELECT work_item_id FROM runs WHERE id = ?", ["run_1"]).work_item_id, null);
  });

  it("rolls up linked run statuses per work item in one query", () => {
    const { store, insertRun } = createHarness();
    const item = store.createWorkItem({ title: "Rollup" });
    insertRun("run_1", "succeeded", item.id);
    insertRun("run_2", "paused", item.id);
    insertRun("run_3", "queued", null);

    const summaries = store.workItemRunSummaries();
    const summary = summaries.get(item.id);
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.byStatus, { succeeded: 1, paused: 1 });
    assert.equal(summaries.size, 1);
  });

  it("deletes a work item and cascades its events; a failed linked run never touches ticket status", () => {
    const { store, insertRun, all } = createHarness();
    const item = store.createWorkItem({ title: "Doomed", status: "review" });
    insertRun("run_1", "failed", item.id);
    // The ticket keeps its human-legible lane even with a failed run linked.
    assert.equal(store.getWorkItem(item.id).status, "review");

    const deleted = store.deleteWorkItem(item.id);
    assert.equal(deleted.id, item.id);
    assert.equal(store.getWorkItem(item.id), null);
    assert.equal(all("SELECT * FROM work_item_events WHERE work_item_id = ?", [item.id]).length, 0);
    assert.equal(store.deleteWorkItem(item.id), null);
  });
});
