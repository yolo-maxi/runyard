// Human-readable labels for every status enum a user can meet in the app:
// run lifecycle states, terminal failure classes, approval decisions, and
// runner/token liveness. Surfaces render these labels; the raw enum stays
// available for CSS classes, filters, and tooltips.
export const STATUS_LABELS = {
  // Run lifecycle
  queued: "Queued",
  assigned: "Assigned",
  running: "Running",
  waiting_approval: "Waiting for approval",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  // Terminal failure classes that double as run statuses
  blocked_by_gate: "Stopped at a safety gate",
  blocked_by_preflight: "Failed preflight checks",
  provider_limited: "Provider rate-limited",
  timed_out: "Timed out",
  invalid_output: "Invalid output",
  infra_unavailable: "Infrastructure unavailable",
  needs_human: "Needs a human decision",
  // Approvals
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
  resolved: "Resolved",
  superseded: "Superseded",
  expired: "Expired",
  // Liveness (runners, tokens)
  online: "Online",
  offline: "Offline",
  // Legacy values still present in older records
  error: "Error",
  recovered: "Recovered"
};

// Label for a status enum; unknown values get a readable sentence-case
// fallback ("some_new_state" → "Some new state") instead of raw snake_case.
export function humanizeStatus(value) {
  const key = String(value || "").toLowerCase();
  if (!key) return "";
  if (STATUS_LABELS[key]) return STATUS_LABELS[key];
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
