import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approvalListQuery,
  approvalInsertQuery,
  approvalLookupQuery,
  approvalPolicyNotifiesTelegram,
  approvalRecord,
  approvalResolution,
  approvalResolutionUpdateQuery,
  isLegacyWorkflowStartApproval,
  legacyWorkflowStartApprovalUpdate,
  legacyWorkflowStartRunUpdate,
  normalizeApproval,
  pendingWorkflowStartApprovalsQuery
} from "../src/operatorRecords.js";

describe("operator record helpers", () => {
  it("builds and normalizes approval records", () => {
    const record = approvalRecord({
      id: "appr_1",
      runId: "run_1",
      title: "Approve deploy",
      description: "Ship it?",
      requestedBy: "workflow",
      payload: { kind: "checkpoint" },
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(record.status, "pending");
    assert.equal(record.payload, '{"kind":"checkpoint"}');
    // No timer requested = blocking approval: NULL timer columns.
    assert.equal(record.timeout_at, null);
    assert.equal(record.fallback, null);
    assert.deepEqual(normalizeApproval({ ...record, resolved_at: null, resolved_by: null, decision: null, comment: null }), {
      id: "appr_1",
      runId: "run_1",
      status: "pending",
      title: "Approve deploy",
      description: "Ship it?",
      requestedBy: "workflow",
      payload: { kind: "checkpoint" },
      createdAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
      resolvedBy: null,
      decision: null,
      comment: null,
      timeoutAt: null,
      fallback: null,
      timerState: "",
      timerElapsedAt: null
    });
  });

  it("stores timed-approval columns only when a timer is present", () => {
    const timed = approvalRecord({
      id: "appr_2",
      title: "Timed",
      createdAt: "2026-01-01T00:00:00.000Z",
      timeoutAt: "2026-01-01T01:00:00.000Z",
      fallback: { decision: "approved", comment: "" }
    });
    assert.equal(timed.timeout_at, "2026-01-01T01:00:00.000Z");
    assert.equal(timed.fallback, '{"decision":"approved","comment":""}');

    // A fallback without a timer is inert and must not be stored.
    const blocking = approvalRecord({
      id: "appr_3",
      title: "Blocking",
      createdAt: "2026-01-01T00:00:00.000Z",
      fallback: { decision: "approved" }
    });
    assert.equal(blocking.timeout_at, null);
    assert.equal(blocking.fallback, null);
  });

  it("normalizes approval decisions into run/audit side-effect metadata", () => {
    assert.deepEqual(approvalResolution("approved", "ignored"), {
      normalizedDecision: "approved",
      status: "approved",
      auditAction: "approval.approved",
      eventType: "approval.approved",
      runStatus: "queued",
      currentStep: "approval granted; queued",
      completedAt: null
    });

    assert.deepEqual(approvalResolution("changes_requested", "2026-01-01T00:00:00.000Z"), {
      normalizedDecision: "changes_requested",
      status: "rejected",
      auditAction: "approval.changes_requested",
      eventType: "approval.changes_requested",
      runStatus: "cancelled",
      currentStep: "changes requested; run cancelled",
      completedAt: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(approvalResolution("anything_else", "done").normalizedDecision, "rejected");
  });

  it("detects Telegram approval notification policy variants", () => {
    assert.equal(approvalPolicyNotifiesTelegram(null), false);
    assert.equal(approvalPolicyNotifiesTelegram({ notifyTelegram: true }), true);
    assert.equal(approvalPolicyNotifiesTelegram({ telegramNotify: true }), true);
    assert.equal(approvalPolicyNotifiesTelegram({ notifications: { telegram: true } }), true);
    assert.equal(approvalPolicyNotifiesTelegram({ notify: { telegram: true } }), true);
    assert.equal(approvalPolicyNotifiesTelegram({ notificationChannel: "Telegram" }), true);
    assert.equal(approvalPolicyNotifiesTelegram({ notifyChannels: ["email", "telegram"] }), true);
    assert.equal(approvalPolicyNotifiesTelegram({ notifyChannels: ["email"] }), false);
  });

  it("builds legacy workflow-start approval auto-queue helpers", () => {
    assert.equal(isLegacyWorkflowStartApproval({ payload: '{"kind":"run_start"}' }), true);
    assert.equal(isLegacyWorkflowStartApproval({ payload: '{"approvalScope":"workflow_start"}' }), true);
    assert.equal(isLegacyWorkflowStartApproval({ payload: '{"kind":"checkpoint"}' }), false);

    assert.deepEqual(pendingWorkflowStartApprovalsQuery(), {
      sql: `SELECT approvals.*, runs.status AS run_status
       FROM approvals
       JOIN runs ON runs.id = approvals.run_id
      WHERE approvals.status = 'pending'
        AND runs.status = 'waiting_approval'`,
      params: []
    });
    assert.deepEqual(legacyWorkflowStartApprovalUpdate({ approvalId: "appr_1", timestamp: "2026-01-01T00:00:00.000Z" }), {
      sql: "UPDATE approvals SET status='approved', decision='approved', resolved_by='system:auto-queue', comment=?, resolved_at=? WHERE id=? AND status='pending'",
      params: ["Workflow-start approvals no longer block runs by default.", "2026-01-01T00:00:00.000Z", "appr_1"]
    });
    assert.deepEqual(legacyWorkflowStartRunUpdate({ runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" }), {
      sql: "UPDATE runs SET status='queued', current_step='queued', updated_at=? WHERE id=? AND status='waiting_approval'",
      params: ["2026-01-01T00:00:00.000Z", "run_1"]
    });
  });

  it("builds approval list queries with optional status", () => {
    assert.deepEqual(approvalListQuery("pending"), {
      sql: "SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC",
      params: ["pending"]
    });
    assert.deepEqual(approvalListQuery(), {
      sql: "SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100",
      params: []
    });
  });

  it("builds approval insert, lookup, and resolution update queries", () => {
    const resolution = approvalResolution("approved", "ignored");

    assert.deepEqual(approvalInsertQuery(), {
      sql: `INSERT INTO approvals (id, run_id, status, title, description, requested_by, payload, created_at, timeout_at, fallback)
     VALUES ($id, $run_id, $status, $title, $description, $requested_by, $payload, $created_at, $timeout_at, $fallback)`
    });
    assert.deepEqual(approvalLookupQuery("appr_1"), {
      sql: "SELECT * FROM approvals WHERE id = ?",
      params: ["appr_1"]
    });
    assert.deepEqual(
      approvalResolutionUpdateQuery({
        approvalId: "appr_1",
        resolution,
        resolvedBy: "operator",
        comment: "ok",
        resolvedAt: "2026-01-01T00:00:00.000Z"
      }),
      {
        sql: "UPDATE approvals SET status=?, decision=?, resolved_by=?, comment=?, resolved_at=? WHERE id=? AND status='pending'",
        params: ["approved", "approved", "operator", "ok", "2026-01-01T00:00:00.000Z", "appr_1"]
      }
    );
  });
});
