import {
  alertInsertQuery,
  alertListQuery,
  alertRecord,
  latestAlertQuery,
  normalizeAlert
} from "./alertPresentation.js";
import {
  approvalInsertQuery,
  approvalListQuery,
  approvalLookupQuery,
  approvalRecord,
  approvalResolution,
  approvalResolutionUpdateQuery,
  isLegacyWorkflowStartApproval,
  legacyWorkflowStartApprovalUpdate,
  legacyWorkflowStartRunUpdate,
  normalizeApproval,
  pendingWorkflowStartApprovalsQuery
} from "./operatorRecords.js";
import {
  artifactInsertQuery,
  artifactListQuery,
  artifactLookupQuery,
  artifactRecord,
  normalizeArtifact
} from "./operatorArtifactRecords.js";
import {
  auditInsertQuery,
  auditListQuery,
  auditRecord,
  normalizeAudit
} from "./operatorAuditRecords.js";

export function createOperatorStore({ all, one, run, id, now, addRunEvent, getRun, updateRun }) {
  function recordAlert({ kind, level = "info", title = "", message = "", data = {} }) {
    const record = alertRecord({ id: id("alert"), kind, level, title, message, data, createdAt: now() });
    const query = alertInsertQuery();
    run(query.sql, record);
    return normalizeAlert(record);
  }

  function listAlerts({ kind = "", limit = 50 } = {}) {
    const query = alertListQuery({ kind, limit });
    return all(query.sql, query.params).map(normalizeAlert);
  }

  function latestAlert(kind) {
    const query = latestAlertQuery(kind);
    return normalizeAlert(one(query.sql, query.params));
  }

  function getArtifact(artifactId) {
    const query = artifactLookupQuery(artifactId);
    return normalizeArtifact(one(query.sql, query.params));
  }

  function createArtifact({
    runId,
    name,
    kind = "file",
    mimeType = "application/octet-stream",
    sizeBytes = 0,
    path: filePath,
    metadata = {}
  }) {
    const record = artifactRecord({
      id: id("art"),
      runId,
      name,
      kind,
      mimeType,
      sizeBytes,
      path: filePath,
      metadata,
      createdAt: now()
    });
    const query = artifactInsertQuery();
    run(query.sql, record);
    addRunEvent(runId, "artifact.created", `Artifact stored: ${name}`, { artifactId: record.id });
    return getArtifact(record.id);
  }

  function listArtifacts({ runId = "", q = "" } = {}) {
    const query = artifactListQuery({ runId, q });
    return all(query.sql, query.params).map(normalizeArtifact);
  }

  function createApproval({ runId = null, title, description = "", requestedBy = "workflow", payload = {} }) {
    const approval = approvalRecord({ id: id("appr"), runId, title, description, requestedBy, payload, createdAt: now() });
    const query = approvalInsertQuery();
    run(query.sql, approval);
    if (runId) addRunEvent(runId, "approval.requested", title, { approvalId: approval.id });
    return getApproval(approval.id);
  }

  function getApproval(approvalId) {
    const query = approvalLookupQuery(approvalId);
    return normalizeApproval(one(query.sql, query.params));
  }

  function listApprovals(status = "") {
    const query = approvalListQuery(status);
    return all(query.sql, query.params).map(normalizeApproval);
  }

  function recordAudit(actor, action, target = null, detail = {}) {
    const entry = auditRecord({ id: id("aud"), actor, action, target, detail, createdAt: now() });
    const query = auditInsertQuery();
    run(query.sql, entry);
    return normalizeAudit(entry);
  }

  function listAudit({ limit = 100 } = {}) {
    const query = auditListQuery({ limit });
    return all(query.sql, query.params).map(normalizeAudit);
  }

  function resolveApproval(approvalId, decision, resolvedBy = "api", comment = "") {
    const resolvedAt = now();
    const resolution = approvalResolution(decision, resolvedAt);
    const query = approvalResolutionUpdateQuery({ approvalId, resolution, resolvedBy, comment, resolvedAt });
    run(query.sql, query.params);
    const approval = getApproval(approvalId);
    if (approval) recordAudit(resolvedBy, resolution.auditAction, approvalId, {
      runId: approval.runId,
      decision: resolution.normalizedDecision,
      comment
    });
    if (approval?.runId) {
      addRunEvent(approval.runId, resolution.eventType, approval.title, {
        approvalId,
        decision: resolution.normalizedDecision,
        comment
      });
      const runRecord = getRun(approval.runId);
      if (runRecord?.status === "waiting_approval") {
        updateRun(approval.runId, {
          status: resolution.runStatus,
          current_step: resolution.currentStep,
          completed_at: resolution.completedAt
        });
      }
    }
    return approval;
  }

  function autoQueueLegacyRunStartApprovals() {
    const query = pendingWorkflowStartApprovalsQuery();
    let queued = 0;
    for (const approval of all(query.sql, query.params)) {
      if (!isLegacyWorkflowStartApproval(approval)) continue;

      const timestamp = now();
      const approvalUpdate = legacyWorkflowStartApprovalUpdate({ approvalId: approval.id, timestamp });
      const runUpdate = legacyWorkflowStartRunUpdate({ runId: approval.run_id, timestamp });
      run(approvalUpdate.sql, approvalUpdate.params);
      run(runUpdate.sql, runUpdate.params);
      addRunEvent(approval.run_id, "approval.auto_queued", "Workflow start approval auto-queued", {
        approvalId: approval.id
      });
      queued += 1;
    }
    return queued;
  }

  return {
    autoQueueLegacyRunStartApprovals,
    createApproval,
    createArtifact,
    getApproval,
    getArtifact,
    latestAlert,
    listAlerts,
    listApprovals,
    listArtifacts,
    listAudit,
    recordAlert,
    recordAudit,
    resolveApproval
  };
}
