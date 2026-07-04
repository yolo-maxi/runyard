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
  createApproval,
  createRun,
  db,
  getApproval,
  getCapability,
  getRun,
  hasEngineApprovalWait,
  reapStuckRunIds,
  registerRunner,
  resolveApproval,
  resolveEngineApprovalOnResume,
  runApprovalHold,
  transitionRun,
  updateRun
} = await import("../src/db.js");
const { env } = await import("../src/env.js");

function oldIso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function startRun({ heartbeatMsAgo = 0, startedMsAgo = 60_000, capabilitySlug = "hello", input = { topic: "liveness" } } = {}) {
  const capability = getCapability(capabilitySlug);
  const run = createRun(capability, input);
  const runner = registerRunner({ name: `runner-${run.id}`, hostname: "test", tags: ["smithers", "vps"] });
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

  it("does not reap a run that is waiting for approval", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 30_000;
    env.runStallMs = 1_000;
    try {
      const { runId } = startRun({ heartbeatMsAgo: 100, startedMsAgo: 60_000 });
      updateRun(runId, {
        status: "waiting_approval",
        current_step: "skin:approval",
        assigned_at: oldIso(60_000),
        started_at: oldIso(60_000)
      });
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60_000), runId);

      assert.deepEqual(reapStuckRunIds(0), []);
      assert.equal(getRun(runId).status, "waiting_approval");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("does not mark a quiet run-smithers parent stalled while its child waits for approval", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 30_000;
    env.runStallMs = 1_000;
    try {
      const { runId: parentRunId } = startRun({
        heartbeatMsAgo: 100,
        startedMsAgo: 60_000,
        capabilitySlug: "run-smithers",
        input: { wrappedCapability: "hello", wrappedInput: { topic: "child approval" } }
      });
      updateRun(parentRunId, {
        assigned_at: oldIso(60_000),
        started_at: oldIso(60_000)
      });
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60_000), parentRunId);

      const child = createRun(getCapability("hello"), { topic: "child approval" });
      updateRun(child.id, { status: "waiting_approval", current_step: "skin:approval" });
      db.prepare("UPDATE runs SET input = ? WHERE id = ?").run(
        JSON.stringify({ topic: "child approval", __origin: { type: "run-smithers-child", parentRunId } }),
        child.id
      );

      assert.deepEqual(reapStuckRunIds(0), []);
      assert.equal(getRun(parentRunId).status, "running");
      assert.equal(getRun(child.id).status, "waiting_approval");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  // Regression: "workflow asks for approval → human does not reply in time →
  // run times out and fails". A missed approval must never be a terminal
  // failure reason: blocking approvals wait indefinitely.
  it("never stall-fails a running run whose own approval goes unanswered, and resumes reaping once resolved", () => {
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
      const approval = createApproval({
        runId,
        title: "Approve checkpoint",
        description: "workflow paused for a human decision",
        requestedBy: "workflow: test"
      });
      // Backdate every event (including approval.requested) so only the pending
      // approval — not event freshness — can be holding the run open.
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60_000), runId);

      assert.equal(runApprovalHold(getRun(runId)), true);
      assert.deepEqual(reapStuckRunIds(0), []);
      assert.equal(getRun(runId).status, "running");

      // The hold releases with the human decision; a genuinely quiet run is
      // reaped again afterwards.
      resolveApproval(approval.id, "approved", "test");
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60_000), runId);
      assert.equal(runApprovalHold(getRun(runId)), false);
      assert.deepEqual(reapStuckRunIds(0), [runId]);
      assert.equal(getRun(runId).status, "failed");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("never max-runtime-fails a run-smithers parent while its child waits for approval", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 30_000;
    env.runStallMs = 60 * 60_000;
    try {
      const { runId: parentRunId } = startRun({
        heartbeatMsAgo: 100,
        startedMsAgo: 60 * 60_000,
        capabilitySlug: "run-smithers",
        input: { wrappedCapability: "hello", wrappedInput: { topic: "slow approver" } }
      });
      updateRun(parentRunId, {
        assigned_at: oldIso(60 * 60_000),
        started_at: oldIso(60 * 60_000)
      });

      const child = createRun(getCapability("hello"), { topic: "slow approver" });
      updateRun(child.id, { status: "waiting_approval", current_step: "skin:approval" });
      db.prepare("UPDATE runs SET input = ? WHERE id = ?").run(
        JSON.stringify({ topic: "slow approver", __origin: { type: "run-smithers-child", parentRunId } }),
        child.id
      );

      // Backstop of 5 minutes, run started an hour ago: without the approval
      // hold this parent would fail as max_runtime. (Other tests' leftover runs
      // may legitimately trip the backstop, so assert on this parent only.)
      const reaped = reapStuckRunIds(5 * 60_000);
      assert.ok(!reaped.includes(parentRunId), `parent ${parentRunId} must not be reaped (reaped: ${reaped.join(", ")})`);
      assert.equal(getRun(parentRunId).status, "running");
      assert.equal(getRun(child.id).status, "waiting_approval");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  // Engine-level Smithers <Approval> pauses: the runner bridge posts
  // engine.approval.waiting / engine.approval.resumed run events. The waiting
  // event alone (no Hub approval card) must hold the run against both the
  // stall window and the max-runtime backstop — it is the conservative belt
  // when card creation fails.
  it("never stall- or deadline-fails a run parked at an engine-level approval, even without a card", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 30_000;
    env.runStallMs = 1_000;
    try {
      const { runId } = startRun({ heartbeatMsAgo: 100, startedMsAgo: 60 * 60_000 });
      updateRun(runId, {
        assigned_at: oldIso(60 * 60_000),
        started_at: oldIso(60 * 60_000)
      });
      addRunEvent(runId, "engine.approval.waiting", "paused at engine approval", {
        smithersRunId: "run_sm_test",
        nodeId: "ship-gate"
      });
      // Backdate everything so only the engine-approval hold can protect the run.
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60 * 60_000), runId);

      assert.equal(hasEngineApprovalWait(runId), true);
      assert.equal(runApprovalHold(getRun(runId)), true);
      const reaped = reapStuckRunIds(5 * 60_000);
      assert.ok(!reaped.includes(runId), `run ${runId} must not be reaped (reaped: ${reaped.join(", ")})`);
      assert.equal(getRun(runId).status, "running");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("releases the engine-approval hold once the gate resumes, then reaps a genuinely quiet run", () => {
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
      addRunEvent(runId, "engine.approval.waiting", "paused at engine approval", {
        smithersRunId: "run_sm_test",
        nodeId: "ship-gate"
      });
      addRunEvent(runId, "engine.approval.resumed", "gate decided", {
        smithersRunId: "run_sm_test",
        nodeId: "ship-gate",
        engineDecision: "approved"
      });
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60_000), runId);

      assert.equal(hasEngineApprovalWait(runId), false);
      assert.equal(runApprovalHold(getRun(runId)), false);
      assert.deepEqual(reapStuckRunIds(0), [runId]);
      assert.equal(getRun(runId).status, "failed");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("keeps holding while any of several engine gates is still waiting", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 30_000;
    env.runStallMs = 1_000;
    try {
      const { runId } = startRun({ heartbeatMsAgo: 100, startedMsAgo: 60_000 });
      updateRun(runId, { assigned_at: oldIso(60_000), started_at: oldIso(60_000) });
      addRunEvent(runId, "engine.approval.waiting", "gate a", { smithersRunId: "run_sm_test", nodeId: "gate-a" });
      addRunEvent(runId, "engine.approval.waiting", "gate b", { smithersRunId: "run_sm_test", nodeId: "gate-b" });
      addRunEvent(runId, "engine.approval.resumed", "gate a decided", {
        smithersRunId: "run_sm_test",
        nodeId: "gate-a",
        engineDecision: "approved"
      });
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60_000), runId);

      assert.equal(hasEngineApprovalWait(runId), true);
      assert.deepEqual(reapStuckRunIds(0), []);
      assert.equal(getRun(runId).status, "running");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("auto-resolves a pending engine_approval card when the gate was decided engine-side", () => {
    const { runId } = startRun({ heartbeatMsAgo: 100, startedMsAgo: 60_000 });
    const approval = createApproval({
      runId,
      title: "Engine approval: hello · ship-gate",
      requestedBy: "runner: test",
      payload: { kind: "engine_approval", smithersRunId: "run_sm_test", nodeId: "ship-gate" }
    });

    // Unknown decision: never invent an outcome — card stays pending.
    assert.deepEqual(resolveEngineApprovalOnResume(runId, { smithersRunId: "run_sm_test", nodeId: "ship-gate" }), []);
    assert.equal(getApproval(approval.id).status, "pending");

    // Mismatched node: untouched.
    assert.deepEqual(
      resolveEngineApprovalOnResume(runId, { smithersRunId: "run_sm_test", nodeId: "other", engineDecision: "approved" }),
      []
    );

    // Observed engine decision mirrors onto the card; the running run row is untouched.
    assert.deepEqual(
      resolveEngineApprovalOnResume(runId, { smithersRunId: "run_sm_test", nodeId: "ship-gate", engineDecision: "approved" }),
      [approval.id]
    );
    const resolved = getApproval(approval.id);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution, "approved");
    assert.equal(resolved.resolvedVia, "engine");
    assert.equal(resolved.resolvedBy, "engine:cli");
    assert.equal(getRun(runId).status, "running");
  });

  it("does not transition a running run when its engine_approval card is resolved by a human", () => {
    const { runId } = startRun({ heartbeatMsAgo: 100, startedMsAgo: 60_000 });
    const approval = createApproval({
      runId,
      title: "Engine approval: hello · ship-gate",
      requestedBy: "runner: test",
      payload: { kind: "engine_approval", smithersRunId: "run_sm_test", nodeId: "ship-gate" }
    });
    assert.equal(runApprovalHold(getRun(runId)), true);

    resolveApproval(approval.id, "approved", "operator");
    // The run stays running — the runner applies the decision to the engine;
    // the Hub must not requeue or complete anything on card resolution.
    assert.equal(getRun(runId).status, "running");
    assert.equal(getApproval(approval.id).status, "resolved");
    assert.equal(getApproval(approval.id).resolution, "approved");
    assert.equal(getApproval(approval.id).resolvedVia, "human");
  });
});
