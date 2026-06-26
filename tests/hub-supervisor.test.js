import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-supervisor-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_supervisor_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { decideReconcile, HUB_DEFAULT_CAPS, buildHubRepairInput } = await import("../src/hubSupervisor.js");
const {
  addRunEvent,
  claimNextRun,
  createRun,
  db,
  getCapability,
  getRun,
  listApprovals,
  listRunLineage,
  reapStuckRunIds,
  reconcileFailedRecoverable,
  reconcileRepairChildTerminal,
  registerRunner,
  transitionRun
} = await import("../src/db.js");
const { env } = await import("../src/env.js");

function oldIso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

// Start a run, assign it to a runner, mark it running, record a Smithers
// checkpoint (the resumable substrate handle), and age the heartbeat so the
// reaper sees the runner as offline (orphaned).
function startOrphan({ heartbeatMsAgo = 5_000, withCheckpoint = true, input = { topic: "resume" } } = {}) {
  const capability = getCapability("hello");
  const run = createRun(capability, input);
  const runner = registerRunner({ name: `runner-${run.id}`, hostname: "test", tags: ["smithers"] });
  const assignment = claimNextRun(runner.id);
  assert.equal(assignment.run.id, run.id);
  transitionRun(run.id, "running", { started_at: oldIso(60_000), current_step: "running" });
  if (withCheckpoint) {
    addRunEvent(run.id, "smithers.dispatched", "Smithers run started", { smithersRunId: "run-42" });
  }
  db.prepare("UPDATE runners SET last_heartbeat_at = ? WHERE id = ?").run(oldIso(heartbeatMsAgo), runner.id);
  return { runId: run.id, runnerId: runner.id };
}

describe("hubSupervisor.decideReconcile (pure)", () => {
  it("resumes an orphaned run that has a checkpoint and budget", () => {
    const d = decideReconcile({ reason: "runner_offline", error: "econnreset talking to runner", checkpoint: "run-1", attempt: 0 });
    assert.equal(d.action, "resume");
    assert.equal(d.nextAttempt, 1);
  });

  it("gives up terminally when there is no checkpoint", () => {
    const d = decideReconcile({ reason: "runner_offline", error: "boom", checkpoint: null, attempt: 0 });
    assert.equal(d.action, "give_up");
  });

  it("never auto-resumes an operator cancellation", () => {
    const d = decideReconcile({ reason: "runner_offline", checkpoint: "run-1", cancelledIntent: true });
    assert.equal(d.action, "give_up");
  });

  it("does not blind-resume a stalled (possibly-live) run", () => {
    const d = decideReconcile({ reason: "run_stalled", checkpoint: "run-1", attempt: 0 });
    assert.equal(d.action, "give_up");
  });

  it("escalates when the attempt cap is hit", () => {
    const d = decideReconcile({ reason: "runner_offline", checkpoint: "run-1", attempt: HUB_DEFAULT_CAPS.maxAttempts });
    assert.equal(d.action, "escalate");
    assert.equal(d.escalation, "max_attempts");
  });

  it("loop-breaker: same fingerprint, no forward progress N times → escalate", () => {
    const error = "econnreset talking to the model gateway";
    // First resume of this transient fingerprint is allowed...
    const first = decideReconcile({
      reason: "runner_offline", error, checkpoint: "run-1", attempt: 1,
      fingerprintResumes: {}, progressMarker: 5, lastProgressMarker: 0
    });
    assert.equal(first.action, "resume");
    const fp = first.fingerprint;
    // ...but once it has been resumed maxResumesPerFingerprint times with no
    // forward progress (marker unchanged), the loop-breaker escalates rather
    // than resuming forever.
    const looped = decideReconcile({
      reason: "runner_offline", error, checkpoint: "run-1", attempt: 3,
      fingerprintResumes: { [fp]: HUB_DEFAULT_CAPS.maxResumesPerFingerprint },
      progressMarker: 5, lastProgressMarker: 5
    });
    assert.equal(looped.action, "escalate");
    assert.equal(looped.escalation, "loop_breaker");
  });

  it("forward progress resets the loop-breaker (resume continues)", () => {
    const d = decideReconcile({
      reason: "runner_offline", error: "econnreset", checkpoint: "run-1", attempt: 2,
      fingerprintResumes: { "econnreset": HUB_DEFAULT_CAPS.maxResumesPerFingerprint },
      progressMarker: 9, lastProgressMarker: 4
    });
    assert.equal(d.action, "resume");
  });

  it("Phase 2: deterministic code bug repairs once, then escalates if it repeats", () => {
    const error = "ReferenceError: foo is not defined at workflow.tsx:12:3";
    const repair = decideReconcile({ reason: "failed", error, checkpoint: "run-1", attempt: 1, enableRepair: true });
    assert.equal(repair.action, "repair");
    // Same fingerprint already repaired → escalate, never repair twice.
    const again = decideReconcile({
      reason: "failed", error, checkpoint: "run-1", attempt: 2, enableRepair: true,
      repairedFingerprints: { [repair.fingerprint]: 1 }, repairCount: 1
    });
    assert.equal(again.action, "escalate");
    assert.equal(again.escalation, "code_repair_exhausted");
  });

  it("with repair disabled, a code bug escalates after three strikes", () => {
    const error = "TypeError: x is not a function";
    const d = decideReconcile({
      reason: "runner_offline", error, checkpoint: "run-1", attempt: 2, enableRepair: false,
      fingerprintResumes: { [fpOf(error)]: HUB_DEFAULT_CAPS.fingerprintThreshold - 1 },
      progressMarker: 1, lastProgressMarker: 1
    });
    assert.equal(d.action, "escalate");
  });
});

describe("buildHubRepairInput (hub-side repair safety scoping)", () => {
  const decision = { fingerprint: "referenceerror: x is not defined" };

  it("forces a dedicated repair branch and never main", () => {
    const input = buildHubRepairInput({ capabilitySlug: "canary", input: {} }, decision, { wrappedEntry: ".smithers/workflows/canary.tsx" });
    assert.equal(input.targetBranch, "smithers-self-repair");
    assert.notEqual(input.targetBranch, "main");
    assert.equal(input.deploy, false);
    assert.match(input.workPrompt, /Likely source: \.smithers\/workflows\/canary\.tsx/);
  });

  it("honours an explicit repair branch override", () => {
    const input = buildHubRepairInput({ capabilitySlug: "canary", input: {} }, decision, { repairBranch: "hub-repair-x" });
    assert.equal(input.targetBranch, "hub-repair-x");
  });

  it("inherits the failed run's execution routing so the repair stays on the same runner class", () => {
    const exec = { mode: "remote", runnerLocation: "canary-repair-proof", requested: true };
    const input = buildHubRepairInput({ capabilitySlug: "canary", input: { __execution: exec } }, decision);
    assert.deepEqual(input.__execution, exec);
  });

  it("forwards the failed run's repo selector (repoDir > repo > project)", () => {
    assert.equal(buildHubRepairInput({ input: { repoDir: "/srv/repo" } }, decision).repoDir, "/srv/repo");
    assert.equal(buildHubRepairInput({ input: { repo: "runyard" } }, decision).repo, "runyard");
    assert.equal(buildHubRepairInput({ input: { project: "proj" } }, decision).project, "proj");
    // repoDir wins when several are present.
    const input = buildHubRepairInput({ input: { repoDir: "/srv/repo", repo: "runyard" } }, decision);
    assert.equal(input.repoDir, "/srv/repo");
    assert.equal(input.repo, undefined);
  });

  it("omits routing/selector when the failed run carries none (untargeted resolves on the claiming runner)", () => {
    const input = buildHubRepairInput({ capabilitySlug: "canary", input: {} }, decision);
    assert.equal(input.__execution, undefined);
    assert.equal(input.repoDir, undefined);
    assert.equal(input.repo, undefined);
    assert.equal(input.project, undefined);
  });
});

function fpOf(error) {
  // Mirror the module's normalized fingerprint for the strike-count fixture.
  return decideReconcile({ reason: "failed", error, checkpoint: "run-1" }).fingerprint;
}

describe("reaper resumes orphaned runs instead of failing them", () => {
  it("orphaned run with a checkpoint → requeued (queued, runner_id null, attempt++), not failed", () => {
    const prevOffline = env.runnerOfflineMs;
    env.runnerOfflineMs = 1_000;
    try {
      const { runId, runnerId } = startOrphan();
      // The reaper does NOT report it as terminally reaped (it was resumed).
      assert.deepEqual(reapStuckRunIds(0), []);
      const run = getRun(runId);
      assert.equal(run.status, "queued");
      assert.equal(run.runnerId, null);
      const row = db.prepare("SELECT attempt, input FROM runs WHERE id = ?").get(runId);
      assert.equal(row.attempt, 1);
      // The resume marker carries the prior Smithers run id for --resume.
      assert.equal(JSON.parse(row.input).__resume.smithersRunId, "run-42");
      // The freed runner slot is released.
      const runner = db.prepare("SELECT active_runs FROM runners WHERE id = ?").get(runnerId);
      assert.equal(runner.active_runs, 0);
      // A lineage row records the resume.
      const lineage = listRunLineage(runId);
      assert.equal(lineage.at(-1).action, "resume");
    } finally {
      env.runnerOfflineMs = prevOffline;
    }
  });

  it("orphaned run with NO checkpoint → terminal fail (janitor contract preserved)", () => {
    const prevOffline = env.runnerOfflineMs;
    env.runnerOfflineMs = 1_000;
    try {
      const { runId } = startOrphan({ withCheckpoint: false });
      assert.deepEqual(reapStuckRunIds(0), [runId]);
      const run = getRun(runId);
      assert.equal(run.status, "failed");
      assert.equal(run.error, "runner heartbeat expired");
      assert.equal(run.currentStep, "runner offline");
    } finally {
      env.runnerOfflineMs = prevOffline;
    }
  });

  it("idempotency: a second reaper tick cannot double-dispatch a resumed run", () => {
    const prevOffline = env.runnerOfflineMs;
    env.runnerOfflineMs = 1_000;
    try {
      const { runId } = startOrphan();
      reapStuckRunIds(0); // first tick requeues it
      assert.equal(getRun(runId).status, "queued");
      const beforeAttempt = db.prepare("SELECT attempt FROM runs WHERE id = ?").get(runId).attempt;
      // Second tick: the run is queued (not assigned/running), so the reaper's
      // active-set query never sees it again — no second requeue, attempt stable.
      reapStuckRunIds(0);
      const afterAttempt = db.prepare("SELECT attempt FROM runs WHERE id = ?").get(runId).attempt;
      assert.equal(afterAttempt, beforeAttempt);
      const resumes = listRunLineage(runId).filter((l) => l.action === "resume");
      assert.equal(resumes.length, 1);
    } finally {
      env.runnerOfflineMs = prevOffline;
    }
  });

  it("attempt cap exhausted → escalates with an operator approval card", () => {
    const prevOffline = env.runnerOfflineMs;
    env.runnerOfflineMs = 1_000;
    try {
      const { runId } = startOrphan();
      // Pre-load the attempt counter to the cap so the next adjudication escalates.
      db.prepare("UPDATE runs SET attempt = ? WHERE id = ?").run(HUB_DEFAULT_CAPS.maxAttempts, runId);
      assert.deepEqual(reapStuckRunIds(0), [runId]);
      const run = getRun(runId);
      assert.equal(run.status, "failed");
      const cards = listApprovals("pending").filter((a) => a.runId === runId && a.payload?.kind === "supervisor_escalation");
      assert.equal(cards.length, 1);
      assert.equal(cards[0].payload.escalation, "max_attempts");
    } finally {
      env.runnerOfflineMs = prevOffline;
    }
  });
});

describe("Phase 2 hub-side repair: park child, re-run fresh / escalate", () => {
  const codeError = "ReferenceError: multiplier is not defined at canary-repair-proof.tsx:12:5";

  function failedCodeBugRun(input = { topic: "code-bug" }) {
    const cap = getCapability("hello");
    const run = createRun(cap, input);
    addRunEvent(run.id, "smithers.dispatched", "started", { smithersRunId: "run-canary-old" });
    transitionRun(run.id, "running", { current_step: "running" });
    transitionRun(run.id, "failed", { error: codeError, current_step: "failed", completed_at: oldIso(0) });
    return run;
  }

  function parkOn(parentId, childId, fingerprint = "fp", extra = {}) {
    db.prepare("UPDATE runs SET supervisor_meta=? WHERE id=?").run(
      JSON.stringify({ awaitingRepair: true, repairChildRunId: childId, lastFingerprint: fingerprint, repairedFingerprints: { [fingerprint]: 1 }, ...extra }),
      parentId
    );
  }

  it("on a deterministic code bug: dispatches a child, PARKS the parent (no resume), bumps the counter", () => {
    const run = failedCodeBugRun();
    let captured = null;
    const dispatchRepair = (failedRun, decision, checkpoint) => {
      captured = { decision, checkpoint };
      return "run-repair-child-1";
    };
    const acted = reconcileFailedRecoverable({ dispatchRepair });
    assert.ok(acted.includes(run.id));
    assert.ok(captured, "dispatchRepair was called");

    const row = db.prepare("SELECT status, repair_count, supervisor_meta, input FROM runs WHERE id = ?").get(run.id);
    // Parked: still failed, NOT requeued, and NO resume marker was stamped.
    assert.equal(row.status, "failed");
    assert.equal(row.repair_count, 1);
    assert.equal(JSON.parse(row.input).__resume, undefined);
    const meta = JSON.parse(row.supervisor_meta);
    assert.equal(meta.awaitingRepair, true);
    assert.equal(meta.repairChildRunId, "run-repair-child-1");
    assert.equal(meta.repairedFingerprints[captured.decision.fingerprint], 1);

    // While parked (child run id not yet terminal/known), a second tick does not re-dispatch.
    let redispatched = false;
    reconcileFailedRecoverable({ dispatchRepair: () => { redispatched = true; return "x"; } });
    assert.equal(redispatched, false);
  });

  it("repair child SUCCESS re-runs the parent FRESH (queued, new attempt, no resume marker)", () => {
    const cap = getCapability("hello");
    const parent = failedCodeBugRun({ topic: "rerun" });
    const child = createRun(cap, { workPrompt: "fix" }, { origin: { type: "hub-supervisor-repair", repairsRunId: parent.id } });
    parkOn(parent.id, child.id);
    transitionRun(child.id, "running", {});
    transitionRun(child.id, "succeeded", { completed_at: oldIso(0) });

    const out = reconcileRepairChildTerminal(child.id);
    assert.equal(out.action, "rerun");
    const row = db.prepare("SELECT status, input, supervisor_meta, attempt FROM runs WHERE id = ?").get(parent.id);
    assert.equal(row.status, "queued");
    assert.equal(JSON.parse(row.input).__resume, undefined); // fresh — never resume a changed source
    assert.equal(JSON.parse(row.supervisor_meta).awaitingRepair, false);
    assert.equal(listRunLineage(parent.id).at(-1).action, "rerun");

    // Idempotent: a duplicate terminal report does not re-queue again.
    const dup = reconcileRepairChildTerminal(child.id);
    assert.equal(dup, null);
  });

  it("repair child FAILURE escalates the parent to an operator card (code_repair_failed)", () => {
    const cap = getCapability("hello");
    const parent = failedCodeBugRun({ topic: "escal" });
    const child = createRun(cap, { workPrompt: "fix" }, { origin: { type: "hub-supervisor-repair", repairsRunId: parent.id } });
    parkOn(parent.id, child.id);
    transitionRun(child.id, "running", {});
    transitionRun(child.id, "failed", { error: "GATE FAILED: pnpm test did not pass", completed_at: oldIso(0) });

    const out = reconcileRepairChildTerminal(child.id);
    assert.equal(out.action, "escalate");
    const cards = listApprovals("pending").filter((a) => a.runId === parent.id && a.payload?.kind === "supervisor_escalation");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].payload.escalation, "code_repair_failed");
  });

  it("ignores a hub-repair child whose parent is not parked on it (idempotency guard)", () => {
    const cap = getCapability("hello");
    const parent = failedCodeBugRun({ topic: "notparked" });
    const child = createRun(cap, { workPrompt: "fix" }, { origin: { type: "hub-supervisor-repair", repairsRunId: parent.id } });
    // parent left with default meta (no awaitingRepair)
    transitionRun(child.id, "running", {});
    transitionRun(child.id, "succeeded", { completed_at: oldIso(0) });
    assert.equal(reconcileRepairChildTerminal(child.id), null);
    assert.equal(getRun(parent.id).status, "failed");
  });

  it("restart backstop: reconcileFailedRecoverable drives a parked parent whose child already finished", () => {
    const cap = getCapability("hello");
    const parent = failedCodeBugRun({ topic: "backstop" });
    const child = createRun(cap, { workPrompt: "fix" }, { origin: { type: "hub-supervisor-repair", repairsRunId: parent.id } });
    parkOn(parent.id, child.id);
    transitionRun(child.id, "running", {});
    transitionRun(child.id, "succeeded", { completed_at: oldIso(0) });
    // No completion hook ran (simulating a hub restart). The scan must reconcile it.
    const acted = reconcileFailedRecoverable({ dispatchRepair: () => "should-not-be-called" });
    assert.ok(acted.includes(parent.id));
    assert.equal(getRun(parent.id).status, "queued");
  });
});

describe("reconcileFailedRecoverable", () => {
  it("resumes a self-reported failed run that has a checkpoint and budget", () => {
    const capability = getCapability("hello");
    const run = createRun(capability, { topic: "failed-recoverable" });
    addRunEvent(run.id, "smithers.dispatched", "Smithers run started", { smithersRunId: "run-77" });
    transitionRun(run.id, "running", { current_step: "running" });
    transitionRun(run.id, "failed", { error: "econnreset mid-run", current_step: "failed", completed_at: oldIso(0) });

    const acted = reconcileFailedRecoverable({});
    assert.ok(acted.includes(run.id));
    const resumed = getRun(run.id);
    assert.equal(resumed.status, "queued");
    assert.equal(JSON.parse(db.prepare("SELECT input FROM runs WHERE id = ?").get(run.id).input).__resume.smithersRunId, "run-77");
  });

  it("never re-picks a run it already adjudicated terminally", () => {
    const capability = getCapability("hello");
    const run = createRun(capability, { topic: "adjudicated" });
    addRunEvent(run.id, "smithers.dispatched", "Smithers run started", { smithersRunId: "run-88" });
    transitionRun(run.id, "running", { current_step: "running" });
    transitionRun(run.id, "failed", { error: "boom", current_step: "failed", completed_at: oldIso(0) });
    // Mark it adjudicated (as an escalate/give_up would).
    db.prepare("UPDATE runs SET supervisor_meta = ? WHERE id = ?").run(JSON.stringify({ adjudicated: true }), run.id);
    const acted = reconcileFailedRecoverable({});
    assert.ok(!acted.includes(run.id));
    assert.equal(getRun(run.id).status, "failed");
  });

  it("ignores failed runs with no resumable checkpoint", () => {
    const capability = getCapability("hello");
    const run = createRun(capability, { topic: "no-checkpoint" });
    transitionRun(run.id, "running", { current_step: "running" });
    transitionRun(run.id, "failed", { error: "boom", current_step: "failed", completed_at: oldIso(0) });
    const acted = reconcileFailedRecoverable({});
    assert.ok(!acted.includes(run.id));
    assert.equal(getRun(run.id).status, "failed");
  });
});
