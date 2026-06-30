import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-supervisor-slots-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_supervisor_slots_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const {
  claimNextRun,
  createRun,
  db,
  getCapability,
  getRun,
  getRunner,
  reconcileRunnerActiveRuns,
  registerRunner,
  runnerLoad,
  runnerPoolStats,
  supervisorPoolSize,
  transitionRun
} = await import("../src/db.js");

// Claim until the runner reports nothing more, returning the claimed run ids.
function drainClaims(runnerId, max = 50) {
  const claimed = [];
  for (let i = 0; i < max; i++) {
    const assignment = claimNextRun(runnerId);
    if (!assignment?.run) break;
    claimed.push(assignment.run.id);
  }
  return claimed;
}

function freshRunner(capacity, name) {
  return registerRunner({ name, hostname: "test", tags: ["smithers", "vps"], capacity });
}

// Isolate each test from leftover queued runs in the shared module-level DB so
// the pool-gating assertions only ever see the runs the test itself created.
beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM approvals; DELETE FROM runs;");
});

describe("supervisor-slot deadlock fix (separate pools)", () => {
  it("a supervisor run does NOT consume a work slot (capacity 1 still runs supervisor + child)", () => {
    // This is the deadlock in miniature: with one slot, the OLD model let the
    // run-smithers supervisor occupy the only slot and its child could never be
    // claimed. With separate pools, both fit.
    const runner = freshRunner(1, "cap1");
    const supervisor = createRun(getCapability("run-smithers"), { wrappedCapability: "hello", wrappedInput: {} });
    const child = createRun(getCapability("hello"), { topic: "child" });

    const claimed = drainClaims(runner.id);
    assert.ok(claimed.includes(supervisor.id), "supervisor should be claimed");
    assert.ok(claimed.includes(child.id), "child work run should ALSO be claimed despite capacity 1");

    const load = runnerLoad(runner.id);
    assert.equal(load.work, 1, "one work run in flight");
    assert.equal(load.supervisors, 1, "one supervisor in flight");
    // Work pool reports no free slot; supervisor pool is independent.
    assert.equal(getRunner(runner.id).availableSlots, 0);
  });

  it("scales to full work capacity: 4 supervisors + 4 children all schedule (no wedge)", () => {
    const runner = freshRunner(4, "cap4");
    const supervisors = [];
    const children = [];
    for (let i = 0; i < 4; i++) {
      supervisors.push(createRun(getCapability("run-smithers"), { wrappedCapability: "hello", wrappedInput: { i } }));
      children.push(createRun(getCapability("hello"), { topic: `child-${i}` }));
    }

    const claimed = new Set(drainClaims(runner.id));
    for (const s of supervisors) assert.ok(claimed.has(s.id), `supervisor ${s.id} claimed`);
    for (const c of children) assert.ok(claimed.has(c.id), `child ${c.id} claimed`);

    const load = runnerLoad(runner.id);
    assert.equal(load.work, 4, "4 work runs in flight (full work capacity)");
    assert.equal(load.supervisors, 4, "4 supervisors in flight (separate pool)");
  });

  it("work pool stays bounded by capacity", () => {
    const runner = freshRunner(4, "work-bound");
    const work = [];
    for (let i = 0; i < 6; i++) work.push(createRun(getCapability("hello"), { topic: `w-${i}` }));

    const claimed = drainClaims(runner.id);
    assert.equal(claimed.length, 4, "only 4 work runs claimed");
    assert.equal(runnerLoad(runner.id).work, 4);
    const stillQueued = work.filter((w) => getRun(w.id).status === "queued");
    assert.equal(stillQueued.length, 2, "2 work runs remain queued");
  });

  it("supervisor pool stays bounded by supervisorPoolSize(capacity)", () => {
    const runner = freshRunner(4, "sup-bound");
    const limit = supervisorPoolSize(4);
    const supers = [];
    for (let i = 0; i < limit + 2; i++) {
      supers.push(createRun(getCapability("run-smithers"), { wrappedCapability: "hello", wrappedInput: { i } }));
    }
    const claimed = drainClaims(runner.id);
    assert.equal(claimed.length, limit, `only ${limit} supervisors claimed`);
    assert.equal(runnerLoad(runner.id).supervisors, limit);
  });

  it("releasing a work run frees a work slot for the next queued work run", () => {
    const runner = freshRunner(1, "release");
    const a = createRun(getCapability("hello"), { topic: "a" });
    const b = createRun(getCapability("hello"), { topic: "b" });
    const both = new Set([a.id, b.id]);

    let claimed = drainClaims(runner.id);
    assert.equal(claimed.length, 1, "only one work run claimed at capacity 1");
    assert.ok(both.has(claimed[0]));
    const first = claimed[0];
    const second = first === a.id ? b.id : a.id;

    // Complete the claimed one — its work slot releases.
    transitionRun(first, "running");
    transitionRun(first, "succeeded", { completed_at: new Date().toISOString() });
    assert.equal(runnerLoad(runner.id).work, 0);

    claimed = drainClaims(runner.id);
    assert.deepEqual(claimed, [second], "the other work run is claimed after the first releases");
  });
});

describe("active_runs reconciliation from ground truth", () => {
  it("corrects a drifted counter to the real in-flight count", () => {
    const runner = freshRunner(4, "reconcile");
    const r1 = createRun(getCapability("hello"), { topic: "r1" });
    const r2 = createRun(getCapability("hello"), { topic: "r2" });
    drainClaims(runner.id); // claims both -> active_runs == 2

    // Simulate drift: a crashed-without-release run left the counter inflated.
    db.prepare("UPDATE runners SET active_runs = ? WHERE id = ?").run(9, runner.id);
    assert.equal(getRunner(runner.id).activeRuns, getRunner(runner.id).capacity); // clamped display

    const corrected = reconcileRunnerActiveRuns();
    const mine = corrected.find((c) => c.id === runner.id);
    assert.ok(mine, "runner counter was corrected");
    assert.equal(mine.to, 2, "reconciled to the real assigned count");

    // Ground truth: two assigned runs.
    const row = db.prepare("SELECT active_runs FROM runners WHERE id = ?").get(runner.id);
    assert.equal(row.active_runs, 2);

    // A run reaching terminal then reconciling lands at the right number.
    transitionRun(r1.id, "running");
    transitionRun(r1.id, "succeeded", { completed_at: new Date().toISOString() });
    reconcileRunnerActiveRuns();
    assert.equal(db.prepare("SELECT active_runs FROM runners WHERE id = ?").get(runner.id).active_runs, 1);
    assert.equal(getRun(r2.id).status, "assigned");
  });

  it("is a no-op when the counter already matches", () => {
    const runner = freshRunner(2, "no-op");
    createRun(getCapability("hello"), { topic: "x" });
    drainClaims(runner.id);
    reconcileRunnerActiveRuns(); // normalize first
    const corrected = reconcileRunnerActiveRuns();
    assert.equal(corrected.find((c) => c.id === runner.id), undefined, "no correction needed");
  });

  it("pool summary counts work slots, not supervisor envelopes or cached drift", () => {
    const runner = freshRunner(4, "pool-summary");
    createRun(getCapability("run-smithers"), { wrappedCapability: "hello", wrappedInput: {} });
    createRun(getCapability("hello"), { topic: "work-1" });
    createRun(getCapability("hello"), { topic: "work-2" });
    drainClaims(runner.id);

    // Simulate the runner heartbeat/counter reading total local processes
    // instead of bounded work slots. The pool UI must still show 2/4 work slots
    // used, with the supervisor surfaced separately.
    db.prepare("UPDATE runners SET active_runs = ? WHERE id = ?").run(3, runner.id);
    const pool = runnerPoolStats();
    assert.ok(pool.totalCapacity >= 4);
    assert.equal(pool.totalActive, 2);
    assert.equal(pool.totalSupervisors, 1);
    assert.ok(pool.availableSlots >= 2);
  });
});
