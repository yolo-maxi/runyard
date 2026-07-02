import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRunner,
  runnerActiveRunsAdjustmentQuery,
  runnerActiveRunsReconcileQuery,
  runnerActiveRunsSetQuery,
  runnerDeleteQuery,
  runnerHeartbeatParams,
  runnerHeartbeatUpdateQuery,
  runnerIsLive,
  runnerListQuery,
  runnerLoadQuery,
  runnerOwnedLookupQuery,
  runnerOwnerTokenQuery,
  runnerRegistrationInsertQuery,
  runnerRegistrationPayload,
  runnerRegistrationUpdateQuery,
  runnerStableIdentityLookupQuery,
  sanitizeRunnerAuthHealth,
  staleRunnerListQuery
} from "../src/runnerRecords.js";

describe("runner record helpers", () => {
  it("builds registration payloads with stable identity defaults", () => {
    const created = runnerRegistrationPayload({
      input: { hostname: "host-1", platform: "linux", tags: ["smithers"], capacity: "4" },
      id: "runner_1",
      tokenId: "tok_1",
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(created.id, "runner_1");
    assert.equal(created.name, "host-1");
    assert.equal(created.tags, '["smithers"]');
    assert.equal(created.capacity, 4);
    assert.equal(created.token_id, "tok_1");

    const updated = runnerRegistrationPayload({
      input: { name: "renamed" },
      existing: { id: "runner_existing", capacity: 8 },
      id: "runner_new",
      timestamp: "2026-01-02T00:00:00.000Z"
    });
    assert.equal(updated.id, "runner_existing");
    assert.equal(updated.capacity, 8);
  });

  it("builds runner registration lookup and write queries", () => {
    const payload = runnerRegistrationPayload({
      input: { name: "runner", hostname: "host", tags: ["smithers"], capacity: 2 },
      existing: { id: "runner_1", capacity: 1 },
      id: "runner_new",
      tokenId: "tok_1",
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.deepEqual(runnerOwnedLookupQuery("runner_1"), {
      sql: "SELECT * FROM runners WHERE id = ?",
      params: ["runner_1"]
    });
    assert.deepEqual(runnerOwnerTokenQuery("runner_1"), {
      sql: "SELECT token_id FROM runners WHERE id = ?",
      params: ["runner_1"]
    });
    assert.deepEqual(runnerStableIdentityLookupQuery({ tokenId: "tok_1", name: "runner", hostname: "host" }), {
      sql: "SELECT * FROM runners WHERE token_id = ? AND name = ? AND hostname = ? ORDER BY last_heartbeat_at DESC LIMIT 1",
      params: ["tok_1", "runner", "host"]
    });
    assert.deepEqual(runnerRegistrationUpdateQuery(payload), {
      sql: `UPDATE runners SET name=$name, hostname=$hostname, platform=$platform, version=$version,
       tags=$tags, status='online', capacity=$capacity, last_heartbeat_at=$last_heartbeat_at WHERE id=$id`,
      params: {
        id: "runner_1",
        name: "runner",
        hostname: "host",
        platform: "",
        version: "",
        tags: '["smithers"]',
        capacity: 2,
        last_heartbeat_at: "2026-01-01T00:00:00.000Z"
      }
    });
    assert.deepEqual(runnerRegistrationInsertQuery(), {
      sql: `INSERT INTO runners (id, name, hostname, platform, version, tags, status, token_id, capacity, active_runs, created_at, last_heartbeat_at)
       VALUES ($id, $name, $hostname, $platform, $version, $tags, $status, $token_id, $capacity, 0, $created_at, $last_heartbeat_at)`
    });
  });

  it("sanitizes runner auth health without retaining token-shaped fields", () => {
    const auth = sanitizeRunnerAuthHealth({
      codex: {
        ok: true,
        expiresAt: "x".repeat(100),
        accountId: "acct",
        error: "e".repeat(300),
        accessToken: "secret"
      },
      hub: { ok: false, error: "bad token" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      refreshToken: "secret"
    });

    assert.equal(auth.codex.ok, true);
    assert.equal(auth.codex.expiresAt.length, 64);
    assert.equal(auth.codex.error.length, 200);
    assert.equal("accessToken" in auth.codex, false);
    assert.equal("refreshToken" in auth, false);
    assert.deepEqual(auth.hub, { ok: false, error: "bad token" });
  });

  it("builds heartbeat params with optional capacity, active runs, tags, and auth", () => {
    const params = runnerHeartbeatParams({
      input: {
        tags: ["vps"],
        currentRunId: "run_1",
        capacity: 3,
        activeRuns: "2",
        auth: { claude: { ok: true, accountId: "user" } }
      },
      timestamp: "2026-01-01T00:00:00.000Z",
      runnerId: "runner_1"
    });

    assert.deepEqual(params, [
      "2026-01-01T00:00:00.000Z",
      '["vps"]',
      "run_1",
      3,
      2,
      '{"claude":{"ok":true,"accountId":"user"}}',
      "runner_1"
    ]);
  });

  it("builds runner list, heartbeat, prune, and load queries", () => {
    const heartbeatParams = runnerHeartbeatParams({
      input: { capacity: 3 },
      timestamp: "2026-01-01T00:00:00.000Z",
      runnerId: "runner_1"
    });

    assert.deepEqual(runnerListQuery(), {
      sql: "SELECT * FROM runners ORDER BY last_heartbeat_at DESC",
      params: []
    });
    assert.deepEqual(runnerHeartbeatUpdateQuery(heartbeatParams), {
      sql: `UPDATE runners SET status='online',
       last_heartbeat_at=?,
       tags=COALESCE(?, tags),
       current_run_id=?,
       capacity=COALESCE(?, capacity),
       active_runs=COALESCE(?, active_runs),
       auth_health=COALESCE(?, auth_health)
     WHERE id=?`,
      params: heartbeatParams
    });
    assert.deepEqual(staleRunnerListQuery(60), {
      sql: `SELECT id FROM runners
      WHERE last_heartbeat_at IS NOT NULL
        AND datetime(last_heartbeat_at) < datetime('now', ?)
        AND COALESCE(active_runs, 0) <= 0
        AND current_run_id IS NULL`,
      params: ["-60 seconds"]
    });
    assert.deepEqual(runnerDeleteQuery("runner_1"), {
      sql: "DELETE FROM runners WHERE id = ?",
      params: ["runner_1"]
    });
    assert.deepEqual(runnerLoadQuery({ runnerId: "runner_1", supervisorCapabilitySlug: "run-smithers" }), {
      sql: `SELECT
        COALESCE(SUM(CASE WHEN capability_slug = ? THEN 1 ELSE 0 END), 0) AS supervisors,
        COALESCE(SUM(CASE WHEN capability_slug = ? THEN 0 ELSE 1 END), 0) AS work
       FROM runs
      WHERE runner_id = ? AND status IN ('assigned','running')`,
      params: ["run-smithers", "run-smithers", "runner_1"]
    });
  });

  it("builds active-run counter reconciliation queries", () => {
    assert.deepEqual(runnerActiveRunsAdjustmentQuery({ runnerId: "runner_1", delta: -1 }), {
      sql: "UPDATE runners SET active_runs = MAX(0, COALESCE(active_runs, 0) + ?) WHERE id = ?",
      params: [-1, "runner_1"]
    });
    assert.deepEqual(runnerActiveRunsReconcileQuery(), {
      sql: `SELECT runners.id AS id,
            COALESCE(runners.active_runs, 0) AS stored,
            runners.current_run_id AS current_run_id,
            (SELECT COUNT(*) FROM runs
              WHERE runs.runner_id = runners.id
                AND runs.status IN ('assigned','running')) AS actual
       FROM runners`,
      params: []
    });
    assert.deepEqual(runnerActiveRunsSetQuery({ runnerId: "runner_1", activeRuns: 3 }), {
      sql: "UPDATE runners SET active_runs = ?, current_run_id = CASE WHEN ? <= 0 THEN NULL ELSE current_run_id END WHERE id = ?",
      params: [3, 3, "runner_1"]
    });
  });

  it("normalizes runner rows with clamped active display and real load", () => {
    const runner = normalizeRunner({
      id: "runner_1",
      name: "Runner",
      hostname: "host",
      platform: "linux",
      version: "1.0.0",
      tags: '["smithers"]',
      status: "offline",
      current_run_id: "run_1",
      capacity: 2,
      active_runs: 9,
      auth_health: '{"codex":{"ok":true}}',
      created_at: "2026-01-01T00:00:00.000Z",
      last_heartbeat_at: "2026-01-01T00:01:00.000Z"
    }, {
      live: true,
      load: { work: 1, supervisors: 2 }
    });

    assert.equal(runner.status, "online");
    assert.equal(runner.activeRuns, 2);
    assert.equal(runner.availableSlots, 1);
    assert.deepEqual(runner.tags, ["smithers"]);
    assert.deepEqual(runner.authHealth, { codex: { ok: true } });
  });

  it("computes heartbeat liveness from timestamps", () => {
    assert.equal(runnerIsLive(null, 1000), false);
    assert.equal(runnerIsLive("not a date", 1000), false);
    assert.equal(runnerIsLive(new Date(Date.now() + 1000).toISOString(), 1000), true);
  });
});
