import {
  approvalIfIgnored,
  approvalKindLabel,
  approvalResolutionLabel,
  approvalResolutionSentence,
  approvalResolvedViaLabel
} from "./approvalPresentation.js";
import { deepLinks } from "./deepLinks.js";
import { truncate } from "./presentation.js";
import {
  DIAGNOSTIC_STATUSES,
  isFocusEvent,
  isLogEvent,
  redactSnippet,
  reverseFind
} from "./runEventSummary.js";
import { diagnosticArtifacts } from "./runDiagnosticArtifacts.js";
import { quickFailedStep, quickReasonHint } from "./runDiagnosticHints.js";

export {
  diagnosticArtifactScore,
  diagnosticArtifacts
} from "./runDiagnosticArtifacts.js";
export {
  quickFailedStep,
  quickReasonHint
} from "./runDiagnosticHints.js";

export function findFailureEvent(events) {
  return reverseFind(events, (event) => {
    const type = String(event?.type || "");
    if (/^run\.(?:failed|cancelled|errored)$/i.test(type)) return true;
    if (/^(?:node|task|step|workflow)\.(?:failed|errored|cancelled)$/i.test(type)) return true;
    if (/^Node(?:Failed|Cancelled)$/.test(type)) return true;
    if (/^Run(?:Failed|Cancelled)$/.test(type)) return true;
    return false;
  });
}

export function failureStep(run, events, failureEvent) {
  const data = failureEvent?.data;
  if (data && typeof data === "object") {
    const field = data.step || data.node || data.taskId || data.task || data.nodeId;
    if (field) return String(field);
  }
  if (run?.currentStep) return run.currentStep;
  const lastStep = reverseFind(events, (event) => /^workflow\.step$/i.test(event.type));
  return lastStep?.message || "";
}

export function focusedTimeline(events, failureEvent, { sanitizeForDisplay } = {}) {
  if (!events?.length) return [];
  const failureIndex = failureEvent ? events.findIndex((event) => event.id === failureEvent.id) : events.length - 1;
  const anchor = failureIndex < 0 ? events.length - 1 : failureIndex;
  const window = events.slice(Math.max(0, anchor - 12), Math.min(events.length, anchor + 4));
  return window.filter(isFocusEvent).map((event) => ({
    id: event.id,
    type: event.type,
    message: redactSnippet(event.message, 320),
    createdAt: event.createdAt,
    data: sanitizeForDisplay ? sanitizeForDisplay(event.data || {}) : event.data || {}
  }));
}

export function logExcerpts(events, failureEvent) {
  if (!events?.length) return [];
  const failureIndex = failureEvent ? events.findIndex((event) => event.id === failureEvent.id) : events.length - 1;
  const end = failureIndex < 0 ? events.length : failureIndex + 1;
  const window = events.slice(Math.max(0, end - 30), end);
  const logs = window.filter(isLogEvent);
  return logs.slice(-12).map((event) => ({
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    message: redactSnippet(event.message, 600)
  }));
}

export function relevantApproval(runId, { listApprovals = () => [] } = {}) {
  if (!runId) return null;
  const approvals = listApprovals().filter((approval) => approval.runId === runId);
  if (!approvals.length) return null;
  return (
    approvals.find((approval) => approval.status === "pending")
    || approvals.find((approval) => approval.decision === "changes_requested")
    || approvals.find((approval) => approval.decision === "rejected")
    || approvals[0]
  );
}

export function approvalSummaryForDiagnostics(approval, run = null) {
  if (!approval) return null;
  return {
    id: approval.id,
    status: approval.status,
    kind: approval.kind || "",
    // Humanized labels for the run page — the raw enums stay machine fields.
    kindLabel: approvalKindLabel(approval.kind),
    statusLabel: approval.status === "pending" ? "Pending decision" : "Resolved",
    resolution: approval.resolution || "",
    resolutionLabel: approvalResolutionLabel(approval.resolution) || "",
    resolvedVia: approval.resolvedVia || "",
    resolvedViaLabel: approvalResolvedViaLabel(approval.resolvedVia) || "",
    resolutionSentence: approvalResolutionSentence(approval) || "",
    decision: approval.decision || "",
    title: approval.title || "",
    comment: approval.comment ? truncate(approval.comment, 600) : "",
    requestedBy: approval.requestedBy || "",
    resolvedBy: approval.resolvedBy || "",
    resolvedAt: approval.resolvedAt || "",
    // Timer truth for the run page: the deadline and what silence does.
    timeoutAt: approval.timeoutAt || null,
    timerState: approval.timerState || "",
    fallbackDecision: approval.fallback?.decision || null,
    ifIgnored: approval.status === "pending" ? approvalIfIgnored(approval, run) : "",
    deepLink: deepLinks.approval(approval.id)
  };
}

export function runDiagnostics(run, events = [], artifacts = [], deps = {}) {
  if (!run || !DIAGNOSTIC_STATUSES.has(run.status)) return null;
  const sortedEvents = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const failureEvent = findFailureEvent(sortedEvents);
  const approval = relevantApproval(run.id, deps);
  const cancelEvent = reverseFind(sortedEvents, (event) => /^run\.cancelled$/i.test(event.type));
  // Only treat the approval comment as the cancellation reason when the
  // approval actually drove the cancellation. Otherwise prefer the run-level
  // event/error so unrelated approval comments do not become the headline.
  const approvalCausedCancel = Boolean(
    approval
    && ["changes_requested", "rejected"].includes(approval.resolution || approval.decision)
  );
  let headline;
  if (run.status === "failed" || run.status === "error") {
    headline = redactSnippet(run.error || failureEvent?.message || run.currentStep || "Run failed", 200);
  } else if (run.status === "cancelled" || run.status === "rejected") {
    headline = redactSnippet(
      (approvalCausedCancel && approval?.comment)
      || cancelEvent?.message
      || failureEvent?.message
      || approval?.comment
      || run.currentStep
      || "Run cancelled",
      200
    );
  } else if (run.status === "waiting_approval") {
    headline = truncate(approval?.title || run.currentStep || "Waiting for approval", 200);
  } else {
    headline = truncate(run.currentStep || run.status, 200);
  }
  const step = failureStep(run, sortedEvents, failureEvent);
  return {
    status: run.status,
    headline,
    reason: redactSnippet(run.error || failureEvent?.message || headline, 600),
    failedStep: step || "",
    failureType: failureEvent?.type || (cancelEvent ? cancelEvent.type : ""),
    failedAt: failureEvent?.createdAt || cancelEvent?.createdAt || run.completedAt || null,
    cancelledBy:
      run.status === "cancelled" || run.status === "rejected"
        ? approval?.resolvedBy
          || (cancelEvent?.data && (cancelEvent.data.cancelledBy || cancelEvent.data.actor)) || ""
        : "",
    approval: approvalSummaryForDiagnostics(approval, run),
    timeline: focusedTimeline(sortedEvents, failureEvent || cancelEvent || null, deps),
    logExcerpts: logExcerpts(sortedEvents, failureEvent || cancelEvent || null),
    artifacts: diagnosticArtifacts(artifacts, deps),
    createdAt: run.createdAt,
    completedAt: run.completedAt
  };
}
