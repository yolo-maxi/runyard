import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-approval-timer-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_approval_timer_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const {
  createApproval,
  createRun,
  db,
  getApproval,
  getCapability,
  getRun,
  listAudit,
  reapStuckRunIds,
  resolveApproval,
  runApprovalHold,
  sweepTimedApprovals,
  updateRun
} = await import("../src/db.js");
const { env } = await import("../src/env.js");
const {
  approvalTimeoutAtIso,
  approvalTimerElapsedMs,
  normalizeApprovalFallback
} = await import("../src/approvalTimerRecords.js");

function oldIso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function elapseTimer(approvalId, msAgo = 60_000) {
  db.prepare("UPDATE approvals SET timeout_at = ? WHERE id = ?").run(oldIso(msAgo), approvalId);
}

function runEventTypes(runId) {
  return db.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY created_at, rowid").all(runId).map((row) => row.type);
}

function waitingApprovalRun() {
  const run = createRun(getCapability("hello"), { topic: "timed approval" });
  updateRun(run.id, { status: "waiting_approval", current_step: "approval" });
  return run;
}

describe("timed-approval record helpers", () => {
  it("only recognizes explicit, well-formed fallback decisions", () => {
    assert.deepEqual(normalizeApprovalFallback({ decision: "approved" }), { decision: "approved", comment: "" });
    assert.deepEqual(normalizeApprovalFallback("rejected"), { decision: "rejected", comment: "" });
    assert.deepEqual(normalizeApprovalFallback('{"decision":"changes_requested","comment":"auto"}'), {
      decision: "changes_requested",
      comment: "auto"
    });
    assert.equal(normalizeApprovalFallback({ decision: "approved" }).comment, "");
    assert.equal(normalizeApprovalFallback({ decision: "launch_the_missiles" }), null);
    assert.equal(normalizeApprovalFallback("yes"), null);
    assert.equal(normalizeApprovalFallback({}), null);
    assert.equal(normalizeApprovalFallback(["approved"]), null);
    assert.equal(normalizeApprovalFallback(null), null);
    assert.equal(normalizeApprovalFallback(true), null);
    assert.equal(
      normalizeApprovalFallback({ decision: "approved", comment: "x".repeat(600) }).comment.length,
      500
    );
  });

  it("computes the timer expiry with clamping, and null means blocking", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    assert.equal(approvalTimeoutAtIso({ timeoutMs: 60_000, nowMs }), "2026-01-01T00:01:00.000Z");
    assert.equal(approvalTimeoutAtIso({ timeoutAt: "2026-02-01T00:00:00.000Z", nowMs }), "2026-02-01T00:00:00.000Z");
    // Explicit timeoutAt wins over timeoutMs.
    assert.equal(
      approvalTimeoutAtIso({ timeoutAt: "2026-02-01T00:00:00.000Z", timeoutMs: 1_000, nowMs }),
      "2026-02-01T00:00:00.000Z"
    );
    // Clamped: sub-second floors to 1s, absurd values cap at 30 days.
    assert.equal(approvalTimeoutAtIso({ timeoutMs: 5, nowMs }), "2026-01-01T00:00:01.000Z");
    assert.equal(approvalTimeoutAtIso({ timeoutMs: Number.MAX_SAFE_INTEGER, nowMs }), "2026-01-31T00:00:00.000Z");
    // No usable timer = blocking approval.
    assert.equal(approvalTimeoutAtIso({ nowMs }), null);
    assert.equal(approvalTimeoutAtIso({ timeoutMs: 0, nowMs }), null);
    assert.equal(approvalTimeoutAtIso({ timeoutMs: -5, nowMs }), null);
    assert.equal(approvalTimeoutAtIso({ timeoutMs: "soon", timeoutAt: "not a date", nowMs }), null);
  });

  it("measures elapsed time from approval creation", () => {
    const nowMs = Date.parse("2026-01-01T01:00:00.000Z");
    assert.equal(approvalTimerElapsedMs({ createdAt: "2026-01-01T00:00:00.000Z" }, nowMs), 60 * 60_000);
    assert.equal(approvalTimerElapsedMs({ created_at: "2026-01-01T00:59:00.000Z" }, nowMs), 60_000);
    assert.equal(approvalTimerElapsedMs({}, nowMs), 0);
  });
});

describe("timed-approval creation", () => {
  it("stores the timer and explicit fallback on creation", () => {
    const approval = createApproval({
      title: "Timed with fallback",
      timeoutMs: 60_000,
      fallback: { decision: "approved", comment: "autopilot ok" }
    });
    assert.ok(approval.timeoutAt);
    assert.deepEqual(approval.fallback, { decision: "approved", comment: "autopilot ok" });
    assert.equal(approval.timerState, "");
    assert.equal(approval.timerElapsedAt, null);
  });

  it("ignores a fallback without a timer: blocking approvals stay blocking", () => {
    const approval = createApproval({
      title: "Blocking despite fallback",
      fallback: { decision: "approved" }
    });
    assert.equal(approval.timeoutAt, null);
    assert.equal(approval.fallback, null);
  });

  it("degrades an unrecognizable fallback to none (never invents a decision)", () => {
    const approval = createApproval({
      title: "Timed with garbage fallback",
      timeoutMs: 60_000,
      fallback: { decision: "do-something-dangerous" }
    });
    assert.ok(approval.timeoutAt);
    assert.equal(approval.fallback, null);
  });
});

describe("timed-approval sweep", () => {
  it("leaves unelapsed timers and blocking approvals alone", () => {
    const timed = createApproval({ title: "Not yet elapsed", timeoutMs: 60 * 60_000, fallback: "approved" });
    const blocking = createApproval({ title: "Blocking forever" });
    const swept = sweepTimedApprovals();
    assert.ok(!swept.some((entry) => entry.id === timed.id || entry.id === blocking.id));
    assert.equal(getApproval(timed.id).status, "pending");
    assert.equal(getApproval(blocking.id).status, "pending");
  });

  it("applies an explicit approved fallback through the normal resolution path", () => {
    const run = waitingApprovalRun();
    const approval = createApproval({
      runId: run.id,
      title: "Approve deploy window",
      timeoutMs: 60_000,
      fallback: { decision: "approved", comment: "No human within the window; proceeding per configured autopilot." }
    });
    elapseTimer(approval.id);

    const swept = sweepTimedApprovals();
    const entry = swept.find((item) => item.id === approval.id);
    assert.deepEqual(entry, { id: approval.id, action: "fallback_applied", decision: "approved" });

    const resolved = getApproval(approval.id);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution, "approved");
    assert.equal(resolved.resolvedVia, "fallback_timer");
    assert.equal(resolved.decision, "approved");
    assert.equal(resolved.resolvedBy, "system:approval-timer");
    assert.equal(resolved.timerState, "fallback_applied");
    assert.ok(resolved.timerElapsedAt);
    assert.match(resolved.comment, /No human within the window/);

    // The linked run is unblocked, not failed.
    assert.equal(getRun(run.id).status, "queued");

    const events = runEventTypes(run.id);
    assert.ok(events.includes("approval.timer_elapsed"), `events: ${events.join(", ")}`);
    assert.ok(events.includes("approval.approved"), `events: ${events.join(", ")}`);

    // Audit trail records the elapsed timer and the selected fallback.
    const audit = listAudit({ limit: 50 }).find(
      (row) => row.action === "approval.timer_elapsed" && row.target === approval.id
    );
    assert.ok(audit);
    assert.equal(audit.actor, "system:approval-timer");
    assert.equal(audit.detail.fallbackDecision, "approved");
    assert.ok(audit.detail.elapsedMs >= 0);
  });

  it("applies an explicit rejected fallback (run cancelled by configuration, not by timeout)", () => {
    const run = waitingApprovalRun();
    const approval = createApproval({
      runId: run.id,
      title: "Reject if unattended",
      timeoutMs: 60_000,
      fallback: "rejected"
    });
    elapseTimer(approval.id);

    sweepTimedApprovals();
    const resolved = getApproval(approval.id);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution, "rejected");
    assert.equal(resolved.resolvedVia, "fallback_timer");
    assert.equal(resolved.resolvedBy, "system:approval-timer");
    assert.equal(getRun(run.id).status, "cancelled");
  });

  it("surfaces fallback_required when no fallback is configured: card stays pending, run stays held", () => {
    const previousOffline = env.runnerOfflineMs;
    const previousStall = env.runStallMs;
    env.runnerOfflineMs = 30_000;
    env.runStallMs = 1_000;
    try {
      // A running (not waiting_approval) run so the stall reaper is the threat
      // being tested; the pending card alone must hold it open.
      const run = createRun(getCapability("hello"), { topic: "timed approval" });
      updateRun(run.id, { status: "running", started_at: oldIso(60_000), current_step: "running" });
      const approval = createApproval({
        runId: run.id,
        title: "Needs a human, timer only",
        timeoutMs: 60_000
      });
      elapseTimer(approval.id);

      const swept = sweepTimedApprovals();
      assert.deepEqual(swept.find((item) => item.id === approval.id), {
        id: approval.id,
        action: "fallback_required"
      });

      const surfaced = getApproval(approval.id);
      assert.equal(surfaced.status, "pending");
      assert.equal(surfaced.timerState, "fallback_required");
      assert.ok(surfaced.timerElapsedAt);

      const events = runEventTypes(run.id);
      assert.ok(events.includes("approval.fallback_required"), `events: ${events.join(", ")}`);

      const alert = db
        .prepare("SELECT * FROM _smithers_alerts WHERE kind = 'approval_fallback_required' ORDER BY created_at DESC")
        .get();
      assert.ok(alert);
      assert.match(alert.title, /Needs a human, timer only/);

      // The elapsed timer is non-terminal: the pending card still holds the
      // run against age-based reaping, exactly like a blocking approval.
      db.prepare("UPDATE run_events SET created_at = ? WHERE run_id = ?").run(oldIso(60_000), run.id);
      assert.equal(runApprovalHold(getRun(run.id)), true);
      assert.ok(!reapStuckRunIds(0).includes(run.id));
      assert.equal(getRun(run.id).status, "running");

      // Idempotent: a second sweep does not double-emit.
      assert.ok(!sweepTimedApprovals().some((item) => item.id === approval.id));
      assert.equal(
        runEventTypes(run.id).filter((type) => type === "approval.fallback_required").length,
        1
      );

      // A late human can still decide; the hold then releases normally.
      resolveApproval(approval.id, "approved", "operator");
      assert.equal(getApproval(approval.id).status, "resolved");
      assert.equal(getApproval(approval.id).resolution, "approved");
    } finally {
      env.runnerOfflineMs = previousOffline;
      env.runStallMs = previousStall;
    }
  });

  it("loses the race to a human decision (CAS): sweep never overrides a resolved approval", () => {
    const run = waitingApprovalRun();
    const approval = createApproval({
      runId: run.id,
      title: "Human beats timer",
      timeoutMs: 60_000,
      fallback: "rejected"
    });
    resolveApproval(approval.id, "approved", "operator");
    elapseTimer(approval.id);

    assert.ok(!sweepTimedApprovals().some((item) => item.id === approval.id));
    const resolved = getApproval(approval.id);
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution, "approved");
    assert.equal(resolved.resolvedVia, "human");
    assert.equal(resolved.resolvedBy, "operator");
    assert.equal(resolved.timerState, "");
    assert.equal(getRun(run.id).status, "queued");
  });
});
