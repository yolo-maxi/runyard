import { parseMaybeJson } from "./dbNormalization.js";
export {
  artifactInsertQuery,
  artifactListQuery,
  artifactLookupQuery,
  artifactRecord,
  normalizeArtifact
} from "./operatorArtifactRecords.js";
export {
  auditInsertQuery,
  auditListQuery,
  auditRecord,
  normalizeAudit
} from "./operatorAuditRecords.js";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function approvalRecord({
  id,
  runId = null,
  title,
  description = "",
  requestedBy = "workflow",
  payload = {},
  createdAt,
  timeoutAt = null,
  fallback = null
}) {
  return {
    id,
    run_id: runId,
    status: "pending",
    title,
    description,
    requested_by: requestedBy,
    payload: jsonField(payload, {}),
    created_at: createdAt,
    // NULL timeout_at = blocking approval; fallback is only stored when the
    // requester explicitly configured one (and only with a timer to trigger it).
    timeout_at: timeoutAt,
    fallback: timeoutAt && fallback ? JSON.stringify(fallback) : null
  };
}

export function normalizeApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    title: row.title,
    description: row.description,
    requestedBy: row.requested_by,
    payload: parseMaybeJson(row.payload, {}),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    decision: row.decision,
    comment: row.comment,
    timeoutAt: row.timeout_at || null,
    fallback: row.fallback ? parseMaybeJson(row.fallback, null) : null,
    timerState: row.timer_state || "",
    timerElapsedAt: row.timer_elapsed_at || null
  };
}

export function approvalListQuery(status = "") {
  return status
    ? {
        sql: "SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC",
        params: [status]
      }
    : {
        sql: "SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100",
        params: []
      };
}

export function approvalInsertQuery() {
  return {
    sql: `INSERT INTO approvals (id, run_id, status, title, description, requested_by, payload, created_at, timeout_at, fallback)
     VALUES ($id, $run_id, $status, $title, $description, $requested_by, $payload, $created_at, $timeout_at, $fallback)`
  };
}

export function approvalLookupQuery(approvalId) {
  return {
    sql: "SELECT * FROM approvals WHERE id = ?",
    params: [approvalId]
  };
}

export function approvalResolutionUpdateQuery({ approvalId, resolution, resolvedBy, comment, resolvedAt }) {
  return {
    sql: "UPDATE approvals SET status=?, decision=?, resolved_by=?, comment=?, resolved_at=? WHERE id=? AND status='pending'",
    params: [resolution.status, resolution.normalizedDecision, resolvedBy, comment, resolvedAt, approvalId]
  };
}

export function approvalResolution(decision, completedAt) {
  const normalizedDecision = decision === "approved" ? "approved" : decision === "changes_requested" ? "changes_requested" : "rejected";
  const resolution = {
    approved: {
      status: "approved",
      auditAction: "approval.approved",
      eventType: "approval.approved",
      runStatus: "queued",
      currentStep: "approval granted; queued",
      completedAt: null
    },
    rejected: {
      status: "rejected",
      auditAction: "approval.rejected",
      eventType: "approval.rejected",
      runStatus: "cancelled",
      currentStep: "approval rejected",
      completedAt
    },
    changes_requested: {
      status: "rejected",
      auditAction: "approval.changes_requested",
      eventType: "approval.changes_requested",
      runStatus: "cancelled",
      currentStep: "changes requested; run cancelled",
      completedAt
    }
  }[normalizedDecision];
  return { normalizedDecision, ...resolution };
}

export function approvalPolicyNotifiesTelegram(policy = {}) {
  if (!policy || typeof policy !== "object") return false;
  if (policy.notifyTelegram === true || policy.telegramNotify === true) return true;
  if (policy.notifications?.telegram === true || policy.notify?.telegram === true) return true;

  const channel = String(policy.notificationChannel || policy.notifyChannel || "").toLowerCase();
  if (channel === "telegram") return true;

  const channels = policy.notificationChannels || policy.notifyChannels || [];
  return Array.isArray(channels) && channels.some((item) => String(item).toLowerCase() === "telegram");
}

export function pendingWorkflowStartApprovalsQuery() {
  return {
    sql: `SELECT approvals.*, runs.status AS run_status
       FROM approvals
       JOIN runs ON runs.id = approvals.run_id
      WHERE approvals.status = 'pending'
        AND runs.status = 'waiting_approval'`,
    params: []
  };
}

export function isLegacyWorkflowStartApproval(row) {
  const payload = parseMaybeJson(row?.payload, {});
  const kind = String(payload.approvalKind || payload.kind || "").toLowerCase();
  const scope = String(payload.approvalScope || payload.scope || "").toLowerCase();
  return kind === "run_start" || scope === "workflow_start";
}

export function legacyWorkflowStartApprovalUpdate({ approvalId, timestamp }) {
  return {
    sql: "UPDATE approvals SET status='approved', decision='approved', resolved_by='system:auto-queue', comment=?, resolved_at=? WHERE id=? AND status='pending'",
    params: ["Workflow-start approvals no longer block runs by default.", timestamp, approvalId]
  };
}

export function legacyWorkflowStartRunUpdate({ runId, timestamp }) {
  return {
    sql: "UPDATE runs SET status='queued', current_step='queued', updated_at=? WHERE id=? AND status='waiting_approval'",
    params: [timestamp, runId]
  };
}
