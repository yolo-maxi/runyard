import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-liveness-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_liveness_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const {
  addRunEvent,
  claimNextRun,
  createRun,
  db,
  getCapability,
  getRun,
  reapStuckRunIds,
  registerRunner,
  transitionRun,
  updateRun
} = await import("../src/db.js");
const { env } = await import("../src/env.js");

function oldIso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function startRun({ heartbeatMsAgo = 0, startedMsAgo = 60_000 } = {}) {
  const capability = getCapability("hello");
  const run = createRun(capability, { topic: "liveness" });
  const runner = registerRunner({ name: `runner-${run.id}`, hostname: "test", tags: ["smithers"] });
  const assignment = claimNextRun(runner.id);
  assert.equal(assignment.run.id, run.id);
  transitionRun(run.id, "running", { started_at: oldIso(startedMsAgo), current_step: "running" });
  db.prepare("UPDATE runners SET last_heartbeat_at = ? WHERE id = ?").run(oldIso(heartbeatMsAgo), runner.id);
  return { runId: run.id, runnerId: runner.id };
}

describe("heartbeat-based run liveness", () => {
  it("fails an active run when its assigned runner is offline", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 1_000;
    env.runStallMs = 60 * 60_000;
    try {
      const { runId } = startRun({ heartbeatMsAgo: 5_000 });

      assert.deepEqual(reapStuckRunIds(0), [runId]);

      const run = getRun(runId);
      assert.equal(run.status, "failed");
      assert.equal(run.error, "runner heartbeat expired");
      assert.equal(run.currentStep, "runner offline");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("does not reap a healthy long-running run that keeps heartbeating and emitting events", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 30_000;
    env.runStallMs = 15 * 60_000;
    try {
      const { runId } = startRun({ heartbeatMsAgo: 100, startedMsAgo: 2 * 60 * 60_000 });
      addRunEvent(runId, "workflow.step", "still making progress");

      assert.deepEqual(reapStuckRunIds(0), []);
      assert.equal(getRun(runId).status, "running");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("fails an active run whose runner is online but event stream stalled", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 30_000;
    env.runStallMs = 1_000;
    try {
      const { runId } = startRun({ heartbeatMsAgo: 100, startedMsAgo: 60_000 });
      updateRun(runId, {
        assigned_at: oldIso(60_000),
        started_at: oldIso(60_000)
      });
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60_000), runId);

      assert.deepEqual(reapStuckRunIds(0), [runId]);
      const run = getRun(runId);
      assert.equal(run.status, "failed");
      assert.equal(run.error, "run emitted no events within stall window");
      assert.equal(run.currentStep, "stalled");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });
});
