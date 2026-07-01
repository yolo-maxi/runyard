import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRunnerStore } from "../src/runnerStore.js";

function runnerRow(overrides = {}) {
  return {
    id: "runner_1",
    name: "Runner",
    hostname: "host",
    platform: "linux",
    version: "1.0.0",
    tags: '["smithers"]',
    status: "online",
    token_id: "tok_1",
    capacity: 2,
    active_runs: 0,
    current_run_id: null,
    auth_health: null,
    created_at: "2026-07-01T00:00:00.000Z",
    last_heartbeat_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
}

function createHarness({ oneRows = [runnerRow(), { work: 1, supervisors: 0 }], allRows = [runnerRow()] } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createRunnerStore({
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
    runnerOfflineMs: 60_000,
    runnerPruneMs: 3_600_000,
    supervisorCapabilitySlug: "run-smithers",
    supervisorSlotRatio: 0.5
  });
  return { calls, store };
}

describe("runner store", () => {
  it("registers new runners and loads normalized runner state", () => {
    const { calls, store } = createHarness({
      oneRows: [null, runnerRow(), { work: 0, supervisors: 0 }]
    });

    const runner = store.registerRunner({ name: "Runner", hostname: "host", capacity: 2 }, "tok_1");

    assert.equal(runner.id, "runner_1");
    assert.equal(runner.availableSlots, 2);
    assert.ok(calls.some((call) => call.fn === "run" && String(call.sql).startsWith("INSERT INTO runners")));
  });

  it("reuses owned and stable-identity runner rows", () => {
    const owned = runnerRow({ id: "runner_owned" });
    const { calls, store } = createHarness({
      oneRows: [owned, owned, { work: 0, supervisors: 0 }]
    });

    assert.equal(store.registerRunner({ id: "runner_owned", name: "Runner", hostname: "host" }, "tok_1").id, "runner_owned");
    assert.ok(calls.some((call) => call.fn === "run" && String(call.sql).startsWith("UPDATE runners SET")));

    const stable = runnerRow({ id: "runner_stable" });
    assert.equal(createHarness({
      oneRows: [null, stable, stable, { work: 0, supervisors: 0 }]
    }).store.registerRunner({ name: "Runner", hostname: "host" }, "tok_1").id, "runner_stable");
  });

  it("heartbeats runners and preserves normalized reads", () => {
    const { calls, store } = createHarness({
      oneRows: [runnerRow({ tags: '["vps"]' }), { work: 1, supervisors: 1 }]
    });

    const runner = store.heartbeatRunner("runner_1", {
      tags: ["vps"],
      capacity: 3,
      activeRuns: 2,
      auth: { codex: { ok: true } }
    });

    assert.equal(runner.workRuns, 1);
    const write = calls.find((call) => call.fn === "run");
    assert.equal(write.params[2], null);
    assert.equal(write.params[3], 3);
    assert.equal(write.params[4], 2);
    assert.match(write.params[5], /codex/);
  });

  it("prunes stale idle runners and ignores disabled pruning", () => {
    const { calls, store } = createHarness({
      allRows: [{ id: "runner_1" }, { id: "runner_2" }]
    });

    assert.deepEqual(store.pruneDeadRunners(3_600_000), ["runner_1", "runner_2"]);
    assert.equal(calls.filter((call) => call.fn === "run").length, 2);
    assert.deepEqual(store.pruneDeadRunners(0), []);
  });

  it("adjusts and reconciles active-run counters", () => {
    const { calls, store } = createHarness({
      allRows: [
        { id: "runner_1", stored: 3, actual: 1 },
        { id: "runner_2", stored: 2, actual: 2 }
      ]
    });

    store.adjustRunnerActiveRuns("runner_1", -1);
    store.adjustRunnerActiveRuns("", -1);
    assert.deepEqual(store.reconcileRunnerActiveRuns(), [{ id: "runner_1", from: 3, to: 1 }]);
    assert.equal(calls.filter((call) => call.fn === "run").length, 2);
  });

  it("computes load, liveness, pool size, and runner lists", () => {
    const { store } = createHarness({
      oneRows: [
        { work: 2, supervisors: 1 },
        runnerRow({ id: "runner_1" }), { work: 1, supervisors: 0 },
        runnerRow({ id: "runner_2" }), { work: 0, supervisors: 1 }
      ],
      allRows: [runnerRow({ id: "runner_1" }), runnerRow({ id: "runner_2" })]
    });

    assert.deepEqual(store.runnerLoad("runner_1"), { work: 2, supervisors: 1 });
    assert.deepEqual(store.runnerLoad(""), { work: 0, supervisors: 0 });
    assert.equal(store.supervisorPoolSize(4), 2);
    assert.equal(store.runnerIsLive(new Date(Date.now() + 1000).toISOString()), true);
    assert.deepEqual(store.listRunners().map((runner) => runner.id), ["runner_1", "runner_2"]);
  });
});
