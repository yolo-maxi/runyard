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
  pendingApprovalsOnTerminalRunsQuery,
  pendingWorkflowStartApprovalsQuery
} from "./operatorRecords.js";
import { RUN_TERMINAL } from "./runLifecyclePolicy.js";
import {
  APPROVAL_TIMER_FALLBACK_APPLIED,
  APPROVAL_TIMER_FALLBACK_REQUIRED,
  approvalTimeoutAtIso,
  approvalTimerElapsedMs,
  approvalTimerElapsedUpdateQuery,
  elapsedTimedApprovalsQuery,
  normalizeApprovalFallback
} from "./approvalTimerRecords.js";
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

  function createApproval({
    runId = null,
    title,
    description = "",
    requestedBy = "workflow",
    payload = {},
    timeoutMs = null,
    timeoutAt = null,
    fallback = null
  }) {
    const createdAt = now();
    // A fallback without a timer is inert, and a timer without an explicit,
    // well-formed fallback resolves to the safe fallback_required path.
    const expiresAt = approvalTimeoutAtIso({ timeoutMs, timeoutAt, nowMs: Date.parse(createdAt) });
    const configuredFallback = expiresAt ? normalizeApprovalFallback(fallback) : null;
    const approval = approvalRecord({
      id: id("appr"),
      runId,
      title,
      description,
      requestedBy,
      payload,
      createdAt,
      timeoutAt: expiresAt,
      fallback: configuredFallback
    });
    const query = approvalInsertQuery();
    run(query.sql, approval);
    if (runId) {
      addRunEvent(runId, "approval.requested", title, {
        approvalId: approval.id,
        ...(expiresAt ? { timeoutAt: expiresAt, fallbackDecision: configuredFallback?.decision || null } : {})
      });
    }
    return getApproval(approval.id);
  }

  // Timed-approval sweep, run from the hub maintenance loop. An elapsed timer
  // is never a terminal failure: with an explicitly configured fallback the
  // decision is applied on the human's behalf (through the exact same
  // resolveApproval path a human uses, so run transitions/audit/events hold);
  // without one the still-pending card is surfaced as fallback_required and
  // keeps waiting — the approval hold continues to protect the run.
  function sweepTimedApprovals() {
    const sweptAt = now();
    const nowMs = Date.parse(sweptAt);
    const query = elapsedTimedApprovalsQuery(sweptAt);
    const acted = [];
    for (const row of all(query.sql, query.params)) {
      const approval = normalizeApproval(row);
      const fallback = normalizeApprovalFallback(approval.fallback);
      const timerState = fallback ? APPROVAL_TIMER_FALLBACK_APPLIED : APPROVAL_TIMER_FALLBACK_REQUIRED;
      const update = approvalTimerElapsedUpdateQuery({
        approvalId: approval.id,
        timerState,
        timerElapsedAt: sweptAt
      });
      // CAS: skip if a human resolved it or another sweep handled it first.
      if (!run(update.sql, update.params).changes) continue;

      const elapsedMs = approvalTimerElapsedMs(approval, nowMs);
      const detail = {
        runId: approval.runId,
        timeoutAt: approval.timeoutAt,
        elapsedMs,
        fallbackDecision: fallback?.decision || null
      };
      if (fallback) {
        recordAudit("system:approval-timer", "approval.timer_elapsed", approval.id, detail);
        if (approval.runId) {
          addRunEvent(approval.runId, "approval.timer_elapsed", approval.title, {
            approvalId: approval.id,
            elapsedMs,
            fallbackDecision: fallback.decision
          });
        }
        resolveApproval(
          approval.id,
          fallback.decision,
          "system:approval-timer",
          fallback.comment || `Approval timer elapsed after ${elapsedMs}ms; applied the configured fallback decision (${fallback.decision}).`,
          "fallback_timer"
        );
        acted.push({ id: approval.id, action: timerState, decision: fallback.decision });
      } else {
        recordAudit("system:approval-timer", "approval.fallback_required", approval.id, detail);
        if (approval.runId) {
          addRunEvent(approval.runId, "approval.fallback_required", approval.title, {
            approvalId: approval.id,
            elapsedMs
          });
        }
        recordAlert({
          kind: "approval_fallback_required",
          level: "warn",
          title: `Approval timer elapsed with no fallback: ${approval.title}`,
          message:
            "The approval's timer elapsed but no fallback decision is configured. " +
            "The card stays pending (the run is held, not failed) until a human decides.",
          data: { approvalId: approval.id, ...detail }
        });
        acted.push({ id: approval.id, action: timerState });
      }
    }
    return acted;
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

  // resolvedVia says which mechanism decided: 'human' (default — web, API,
  // CLI, MCP, Telegram all carry a human's decision), 'fallback_timer'
  // (autopilot), 'engine' (decision observed engine-side and mirrored),
  // 'policy' (auto-approval by standing policy), 'system' (housekeeping, e.g.
  // superseded cards on terminal runs).
  function resolveApproval(approvalId, decision, resolvedBy = "api", comment = "", resolvedVia = "human") {
    const resolvedAt = now();
    const resolution = approvalResolution(decision, resolvedAt);
    const query = approvalResolutionUpdateQuery({ approvalId, resolution, resolvedBy, resolvedVia, comment, resolvedAt });
    run(query.sql, query.params);
    const approval = getApproval(approvalId);
    if (approval) recordAudit(resolvedBy, resolution.auditAction, approvalId, {
      runId: approval.runId,
      decision: resolution.normalizedDecision,
      resolvedVia,
      comment
    });
    if (approval?.runId) {
      addRunEvent(approval.runId, resolution.eventType, approval.title, {
        approvalId,
        decision: resolution.normalizedDecision,
        resolvedVia,
        comment
      });
      const runRecord = getRun(approval.runId);
      if (runRecord?.status === "waiting_approval" && resolution.runStatus) {
        updateRun(approval.runId, {
          status: resolution.runStatus,
          current_step: resolution.currentStep,
          completed_at: resolution.completedAt
        });
      }
    }
    return approval;
  }

  // Terminal-run card hygiene, run from the hub maintenance loop. A pending
  // card whose run already reached a terminal state asks a question nobody
  // can act on anymore; resolve it as `superseded` so the approval inbox only
  // ever contains decisions that still matter. Never touches run state, and
  // never touches run-less cards or cards on active/held runs (including
  // waiting_approval, which is not terminal).
  function sweepSupersededApprovals() {
    const query = pendingApprovalsOnTerminalRunsQuery([...RUN_TERMINAL]);
    const swept = [];
    for (const row of all(query.sql, query.params)) {
      const approval = normalizeApproval(row);
      resolveApproval(
        approval.id,
        "superseded",
        "system:run-terminal",
        `Run ${approval.runId} ended (${row.run_status}) while this approval was still pending; the card is superseded.`,
        "system"
      );
      swept.push({ id: approval.id, runId: approval.runId, runStatus: row.run_status });
    }
    return swept;
  }

  // When an engine-level approval gate is decided directly on the runner box
  // (smithers approve/deny) rather than through the Hub card, the runner posts
  // engine.approval.resumed with the observed decision. Mirror that decision
  // onto the still-pending engine_approval card so it does not linger as a
  // phantom hold. Only recognized decisions are mirrored — an unknown decision
  // leaves the card pending for a human (never invent an approval outcome).
  function resolveEngineApprovalOnResume(runId, data = {}) {
    if (!runId) return [];
    const engineDecision = String(data?.engineDecision || "").trim().toLowerCase();
    const decision = engineDecision === "approved" ? "approved" : engineDecision === "rejected" ? "rejected" : "";
    if (!decision) return [];
    const smithersRunId = String(data?.smithersRunId || "").trim();
    const nodeId = String(data?.nodeId ?? "").trim();
    const resolved = [];
    for (const approval of listApprovals("pending")) {
      if (approval.runId !== runId) continue;
      const payload = approval.payload || {};
      if (String(payload.kind || "") !== "engine_approval") continue;
      if (smithersRunId && String(payload.smithersRunId || "") !== smithersRunId) continue;
      if (String(payload.nodeId ?? "") !== nodeId) continue;
      resolveApproval(
        approval.id,
        decision,
        "engine:cli",
        `Engine-side decision observed for approval node '${nodeId || "approval"}' (${decision}); card auto-resolved to match.`,
        "engine"
      );
      resolved.push(approval.id);
    }
    return resolved;
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
    resolveApproval,
    resolveEngineApprovalOnResume,
    sweepSupersededApprovals,
    sweepTimedApprovals
  };
}
