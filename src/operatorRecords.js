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

// The explicit approval taxonomy. Kind says what class of question a card is;
// it is stored at creation (inferred once from the payload conventions the
// creators already use) instead of every consumer re-running payload
// archaeology. `custom` covers ad-hoc API cards and retired legacy kinds
// (run_start/workflow_start).
export const APPROVAL_KINDS = ["workflow_gate", "escalation", "side_effect", "custom"];

const WORKFLOW_GATE_PAYLOAD_KINDS = new Set(["engine_approval", "engine_gate", "checkpoint", "child_run_approval"]);
const WORKFLOW_GATE_PAYLOAD_SCOPES = new Set(["engine_node", "workflow_checkpoint"]);

export function approvalKindFromPayload(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const kind = String(source.approvalKind || source.kind || "").toLowerCase();
  const scope = String(source.approvalScope || source.scope || "").toLowerCase();
  if (WORKFLOW_GATE_PAYLOAD_KINDS.has(kind) || WORKFLOW_GATE_PAYLOAD_SCOPES.has(scope)) return "workflow_gate";
  if (kind === "supervisor_escalation") return "escalation";
  if (kind === "side_effect" || kind === "post_run_hook" || scope === "post_run_hook") return "side_effect";
  return "custom";
}

// resolved_via backfill/inference from the actor strings historical rows used.
// New resolutions pass resolvedVia explicitly; this exists for the migration
// and as a safety net for callers that only know the actor.
export function approvalResolvedViaFromActor(actor = "") {
  const value = String(actor || "").trim().toLowerCase();
  if (value === "system:approval-timer") return "fallback_timer";
  if (value === "engine:cli" || value.startsWith("engine:")) return "engine";
  if (value === "system:auto-queue") return "policy";
  if (value.startsWith("system:")) return "system";
  return "human";
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
    kind: approvalKindFromPayload(payload),
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
    kind: row.kind || approvalKindFromPayload(parseMaybeJson(row.payload, {})),
    title: row.title,
    description: row.description,
    requestedBy: row.requested_by,
    payload: parseMaybeJson(row.payload, {}),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: row.resolution || null,
    resolvedVia: row.resolved_via || null,
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
    sql: `INSERT INTO approvals (id, run_id, status, kind, title, description, requested_by, payload, created_at, timeout_at, fallback)
     VALUES ($id, $run_id, $status, $kind, $title, $description, $requested_by, $payload, $created_at, $timeout_at, $fallback)`
  };
}

export function approvalLookupQuery(approvalId) {
  return {
    sql: "SELECT * FROM approvals WHERE id = ?",
    params: [approvalId]
  };
}

export function approvalResolutionUpdateQuery({ approvalId, resolution, resolvedBy, resolvedVia, comment, resolvedAt }) {
  return {
    sql: "UPDATE approvals SET status='resolved', resolution=?, resolved_via=?, decision=?, resolved_by=?, comment=?, resolved_at=? WHERE id=? AND status='pending'",
    params: [resolution.resolution, resolvedVia, resolution.legacyDecision, resolvedBy, comment, resolvedAt, approvalId]
  };
}

// The honest resolution table. `status` only ever moves pending -> resolved;
// what was decided is `resolution`. `legacyDecision` keeps the old `decision`
// column populated for existing readers (it mirrors resolution for the
// human-vocabulary decisions and stays NULL for superseded). An unknown
// decision is an error, never a silent reject — every caller normalizes to
// this vocabulary before resolving.
const APPROVAL_RESOLUTIONS = {
  approved: {
    resolution: "approved",
    legacyDecision: "approved",
    auditAction: "approval.approved",
    eventType: "approval.approved",
    runStatus: "queued",
    currentStep: "approval granted; queued",
    terminalRun: false
  },
  rejected: {
    resolution: "rejected",
    legacyDecision: "rejected",
    auditAction: "approval.rejected",
    eventType: "approval.rejected",
    runStatus: "cancelled",
    currentStep: "approval rejected",
    terminalRun: true
  },
  changes_requested: {
    resolution: "changes_requested",
    legacyDecision: "changes_requested",
    auditAction: "approval.changes_requested",
    eventType: "approval.changes_requested",
    runStatus: "cancelled",
    currentStep: "changes requested; run cancelled",
    terminalRun: true
  },
  // The run reached a terminal state while the card was still pending; the
  // question is moot. Never transitions the run (runStatus null) — the run is
  // already done by definition.
  superseded: {
    resolution: "superseded",
    legacyDecision: null,
    auditAction: "approval.superseded",
    eventType: "approval.superseded",
    runStatus: null,
    currentStep: null,
    terminalRun: false
  }
};

export function approvalResolution(decision, completedAt) {
  const entry = APPROVAL_RESOLUTIONS[decision];
  if (!entry) throw new Error(`Unknown approval decision: ${JSON.stringify(decision)}`);
  return {
    // normalizedDecision kept as the historical field name callers/audit use.
    normalizedDecision: entry.resolution,
    ...entry,
    completedAt: entry.terminalRun ? completedAt : null
  };
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
    sql: "UPDATE approvals SET status='resolved', resolution='approved', resolved_via='policy', decision='approved', resolved_by='system:auto-queue', comment=?, resolved_at=? WHERE id=? AND status='pending'",
    params: ["Workflow-start approvals no longer block runs by default.", timestamp, approvalId]
  };
}

export function legacyWorkflowStartRunUpdate({ runId, timestamp }) {
  return {
    sql: "UPDATE runs SET status='queued', current_step='queued', updated_at=? WHERE id=? AND status='waiting_approval'",
    params: [timestamp, runId]
  };
}

// Superseded sweep: pending cards whose linked run already reached a terminal
// state. The question those cards ask is moot — resolving them as superseded
// keeps the approval inbox honest (this is the ~60-stale-cards problem from
// the engine-bridge dogfood). Run-less cards (run_id NULL) are never swept.
export function pendingApprovalsOnTerminalRunsQuery(terminalStatuses) {
  const placeholders = terminalStatuses.map(() => "?").join(", ");
  return {
    sql: `SELECT approvals.*, runs.status AS run_status
       FROM approvals
       JOIN runs ON runs.id = approvals.run_id
      WHERE approvals.status = 'pending'
        AND runs.status IN (${placeholders})
      LIMIT 100`,
    params: [...terminalStatuses]
  };
}
