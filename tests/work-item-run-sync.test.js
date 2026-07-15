import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { createWorkItemStore } from "../src/workItemStore.js";
import { createWorkItemRunSync, workItemMoveForRunStatus } from "../src/workItemRunSync.js";
import { createRunMutationStore } from "../src/runMutationStore.js";
import { normalizeRun } from "../src/runRecords.js";

// Run → work item board sync: linked runs move their ticket where the
// mapping is reliable. Mirrors the db.js composition (runMutationStore's
// onRunStatusChange observer feeds createWorkItemRunSync) against a real
// in-memory SQLite so the whole write path is exercised.
function createHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DB_SCHEMA_SQL);
  const one = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params));
  const all = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params));
  const run = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params));
  let counter = 0;
  const now = () => new Date(1750000000000 + ++counter * 1000).toISOString();
  const workItems = createWorkItemStore({ all, one, run, id: (p) => `${p}_${++counter}`, now });
  const sync = createWorkItemRunSync({
    getWorkItem: workItems.getWorkItem,
    updateWorkItem: workItems.updateWorkItem,
    listWorkItemRuns: workItems.listWorkItemRuns
  });
  const getRun = (runId) => normalizeRun(one("SELECT * FROM runs WHERE id = ?", [runId]));
  const runs = createRunMutationStore({
    one,
    run,
    now,
    getRun,
    adjustRunnerActiveRuns: () => {},
    onRunStatusChange: (updatedRun) => sync.syncWorkItemForRun(updatedRun, { trigger: "run_status" })
  });
  const insertRun = (runId, status, workItemId = null) => {
    run("INSERT INTO capabilities (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", ["cap_1", "hello", "Hello", "t", "t"]);
    run(
      `INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version, status, input, work_item_id, created_at, updated_at)
       VALUES (?, 'cap_1', 'hello', 'Hello', 1, ?, '{}', ?, ?, ?)`,
      [runId, status, workItemId, now(), "t"]
    );
  };
  return { workItems, runs, sync, insertRun, getRun };
}

describe("run status → work item move mapping", () => {
  it("moves pre-run tickets In motion when a run goes live", () => {
    for (const from of ["intake", "triaged", "ready", "waiting", "review"]) {
      assert.equal(workItemMoveForRunStatus(from, "running", "run_1")?.to, "running", `from ${from}`);
    }
  });

  it("treats a relaunch as the unblock signal: blocked → running clears the reason", () => {
    const move = workItemMoveForRunStatus("blocked", "running", "run_1");
    assert.equal(move.to, "running");
    assert.equal(move.clearBlockedReason, true);
  });

  it("parks tickets in waiting when the run is held for a human", () => {
    for (const held of ["waiting_approval", "paused", "budget_exceeded"]) {
      assert.equal(workItemMoveForRunStatus("running", held)?.to, "waiting", held);
    }
  });

  it("sends succeeded runs to review — never straight to shipped", () => {
    assert.equal(workItemMoveForRunStatus("running", "succeeded").to, "review");
    assert.equal(workItemMoveForRunStatus("review", "succeeded"), null);
  });

  it("parks failed runs in blocked with an explicit reason (no failed ticket state)", () => {
    const move = workItemMoveForRunStatus("running", "failed", "run_9");
    assert.equal(move.to, "blocked");
    assert.match(move.blockedReason, /run_9 failed/);
  });

  it("never touches done tickets, blocked-on-hold tickets, or cancelled runs", () => {
    for (const done of ["shipped", "accepted", "archived"]) {
      assert.equal(workItemMoveForRunStatus(done, "running"), null, done);
      assert.equal(workItemMoveForRunStatus(done, "succeeded"), null, done);
    }
    assert.equal(workItemMoveForRunStatus("blocked", "succeeded"), null, "operator parked it");
    assert.equal(workItemMoveForRunStatus("blocked", "failed"), null);
    assert.equal(workItemMoveForRunStatus("running", "cancelled"), null, "cancelling is an operator act");
  });
});

describe("run status sync through the mutation store", () => {
  it("a linked run starting moves the ticket to running with an attributed history event", () => {
    const { workItems, runs, insertRun } = createHarness();
    const ticket = workItems.createWorkItem({ title: "Ship it", status: "ready" });
    insertRun("run_a", "queued", ticket.id);

    runs.transitionRun("run_a", "assigned");
    assert.equal(workItems.getWorkItem(ticket.id).status, "running");

    const event = workItems.listWorkItemEvents(ticket.id).find((e) => e.type === "work_item.status_changed");
    assert.match(event.message, /ready -> running/);
    assert.equal(event.data.actor, "run:run_a");
    assert.match(event.data.reason, /run assigned/);
  });

  it("a succeeded run moves the ticket to review; a failed one parks it in blocked", () => {
    const { workItems, runs, insertRun } = createHarness();
    const good = workItems.createWorkItem({ title: "Good", status: "running" });
    insertRun("run_ok", "running", good.id);
    runs.transitionRun("run_ok", "succeeded");
    assert.equal(workItems.getWorkItem(good.id).status, "review");

    const bad = workItems.createWorkItem({ title: "Bad", status: "running" });
    insertRun("run_bad", "running", bad.id);
    runs.transitionRun("run_bad", "failed");
    const parked = workItems.getWorkItem(bad.id);
    assert.equal(parked.status, "blocked");
    assert.match(parked.blockedReason, /run_bad failed/);
  });

  it("terminal outcomes wait for sibling runs: no review move while another linked run is live", () => {
    const { workItems, runs, insertRun } = createHarness();
    const ticket = workItems.createWorkItem({ title: "Two attempts", status: "running" });
    insertRun("run_1", "running", ticket.id);
    insertRun("run_2", "running", ticket.id);

    runs.transitionRun("run_1", "succeeded");
    assert.equal(workItems.getWorkItem(ticket.id).status, "running", "sibling still live");

    runs.transitionRun("run_2", "succeeded");
    assert.equal(workItems.getWorkItem(ticket.id).status, "review");
  });

  it("approval-path writes (updateRun without transitionRun) still sync", () => {
    const { workItems, runs, insertRun } = createHarness();
    const ticket = workItems.createWorkItem({ title: "Gated", status: "ready" });
    insertRun("run_g", "waiting_approval", ticket.id);
    // operatorStore.resolveApproval moves runs with a bare updateRun
    runs.updateRun("run_g", { status: "queued" });
    assert.equal(workItems.getWorkItem(ticket.id).status, "running");
  });

  it("a relaunch on a blocked ticket clears the stale blocked reason", () => {
    const { workItems, runs, insertRun } = createHarness();
    const ticket = workItems.createWorkItem({ title: "Was stuck", status: "blocked", blockedReason: "Run run_old failed" });
    insertRun("run_new", "queued", ticket.id);
    runs.transitionRun("run_new", "running");
    const moved = workItems.getWorkItem(ticket.id);
    assert.equal(moved.status, "running");
    assert.equal(moved.blockedReason, "");
  });

  it("unlinked runs and done tickets never sync", () => {
    const { workItems, runs, insertRun, sync } = createHarness();
    insertRun("run_solo", "running", null);
    assert.equal(runs.transitionRun("run_solo", "succeeded").ok, true, "no ticket, no crash");

    const shipped = workItems.createWorkItem({ title: "Done", status: "shipped" });
    insertRun("run_late", "running", shipped.id);
    runs.transitionRun("run_late", "succeeded");
    assert.equal(workItems.getWorkItem(shipped.id).status, "shipped");

    assert.equal(sync.syncWorkItemForRun(null), null, "sync never throws");
  });
});
