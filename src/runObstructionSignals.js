import {
  highlightEvents as evidenceHighlightEvents,
  safeNumber,
  topEventTypes as evidenceTopEventTypes
} from "./runEvidence.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export function summarizeDiagnostics(diagnostics, { redactText }) {
  if (!diagnostics) return null;
  return {
    status: diagnostics.status || "",
    headline: redactText(diagnostics.headline || "", 240),
    reason: redactText(diagnostics.reason || "", 500),
    failedStep: redactText(diagnostics.failedStep || "", 160),
    failureType: redactText(diagnostics.failureType || "", 160),
    failedAt: diagnostics.failedAt || "",
    cancelledBy: redactText(diagnostics.cancelledBy || "", 120),
    approval: diagnostics.approval
      ? {
          status: diagnostics.approval.status || "",
          decision: diagnostics.approval.decision || "",
          title: redactText(diagnostics.approval.title || "", 200),
          comment: redactText(diagnostics.approval.comment || "", 240),
          requestedBy: redactText(diagnostics.approval.requestedBy || "", 120)
        }
      : null,
    timeline: (diagnostics.timeline || []).slice(-12).map((event) => ({
      type: redactText(event.type || "", 120),
      message: redactText(event.message || "", 220),
      createdAt: event.createdAt || ""
    })),
    logExcerpts: (diagnostics.logExcerpts || []).slice(-8).map((event) => ({
      type: redactText(event.type || "", 120),
      message: redactText(event.message || "", 260),
      createdAt: event.createdAt || ""
    }))
  };
}

export function topEventTypes(logSummary = {}, { redactText }) {
  return evidenceTopEventTypes(logSummary, {
    transform: (value, field) => redactText(value, field === "category" ? 80 : 120),
    count: (value) => safeNumber(value, 0)
  });
}

export function highlightEvents(logSummary = {}, { redactText }) {
  return evidenceHighlightEvents(logSummary, {
    includeId: false,
    transform: (value, field) =>
      redactText(value, {
        type: 120,
        category: 80,
        severity: 40,
        node: 80,
        message: 260
      }[field] || 120)
  });
}

export function countTextMatches(items, re) {
  return items.reduce((count, item) => count + (re.test(`${item.type || ""} ${item.message || ""}`) ? 1 : 0), 0);
}

export function timingSignals(timing) {
  const signals = [];
  if (safeNumber(timing.queuedMs, 0) > 5 * 60_000) signals.push("queued_over_5m");
  if (safeNumber(timing.executionMs, 0) > 20 * 60_000) signals.push("execution_over_20m");
  if (safeNumber(timing.totalMs, 0) > 30 * 60_000) signals.push("total_over_30m");
  return signals;
}

export function computeDetectedSignals({ run, timing, logSummary, highlights, inventory, diagnostics, outputShape }) {
  const totals = logSummary.totals || {};
  const retrySignals = countTextMatches(highlights, /\b(retry|retrying|retried|again|backoff|rerun)\b/i);
  const fallbackSignals = countTextMatches(highlights, /\b(fallback|workaround|degraded|skipped|manual)\b/i);
  const approvalSignals = (logSummary.categories || []).find((entry) => entry.key === "approval")?.count || 0;
  const longTimingSignals = timingSignals(timing);
  const artifactCount = inventory.length;
  const hasOutput = outputShape?.type && outputShape.type !== "null";
  const noWorkflowArtifacts = artifactCount === 0;
  const noStructuredOutput = !hasOutput;
  const status = run?.status || "";
  return {
    terminalStatus: TERMINAL_STATUSES.has(status),
    unsuccessfulTerminalStatus: status && status !== "succeeded",
    errorEvents: safeNumber(totals.errors, 0),
    warningEvents: safeNumber(totals.warnings, 0),
    retrySignals,
    fallbackSignals,
    approvalEvents: safeNumber(approvalSignals, 0),
    longTimingSignals,
    artifactOutputGaps: {
      noWorkflowArtifacts,
      noStructuredOutput
    },
    failedStepPresent: Boolean(diagnostics?.failedStep),
    successfulButPainful:
      status === "succeeded"
      && (safeNumber(totals.errors, 0) > 0
        || safeNumber(totals.warnings, 0) > 0
        || retrySignals > 0
        || fallbackSignals > 0
        || longTimingSignals.length > 0
        || (noWorkflowArtifacts && noStructuredOutput))
  };
}

export function evidenceQuality(signals, logSummary = {}) {
  if (!signals.terminalStatus) return "none";
  let score = 0;
  if (signals.unsuccessfulTerminalStatus) score += 2;
  if (signals.errorEvents > 0) score += 2;
  if (signals.warningEvents > 0) score += 1;
  if (signals.retrySignals > 0 || signals.fallbackSignals > 0) score += 1;
  if (signals.approvalEvents > 0) score += 1;
  if (signals.longTimingSignals.length > 0) score += 1;
  if (signals.failedStepPresent) score += 1;
  if (signals.artifactOutputGaps.noWorkflowArtifacts || signals.artifactOutputGaps.noStructuredOutput) score += 1;
  if (safeNumber(logSummary.totals?.events, 0) > 20) score += 1;
  if (score >= 5) return "rich";
  if (score >= 3) return "moderate";
  if (score >= 1) return "thin";
  return "none";
}
