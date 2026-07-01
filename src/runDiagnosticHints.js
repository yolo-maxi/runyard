import { truncate } from "./presentation.js";
import { DIAGNOSTIC_STATUSES } from "./runEventSummary.js";

// Cheap short hint for run cards. It uses only run-row fields; detail responses
// can afford the richer event/artifact-backed diagnostics object.
export function quickReasonHint(run) {
  if (!run || !DIAGNOSTIC_STATUSES.has(run.status)) return "";
  if (run.status === "failed" || run.status === "error") {
    return truncate(run.error || run.currentStep || "Run failed", 140);
  }
  if (run.status === "cancelled" || run.status === "rejected") {
    return truncate(run.error || run.currentStep || "Run cancelled", 140);
  }
  if (run.status === "waiting_approval") {
    return truncate(run.currentStep || "Waiting for approval", 140);
  }
  return "";
}

export function quickFailedStep(run) {
  if (!run || !DIAGNOSTIC_STATUSES.has(run.status)) return "";
  return String(run.currentStep || "").slice(0, 80);
}
