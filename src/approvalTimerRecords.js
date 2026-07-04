import { parseMaybeJson } from "./dbNormalization.js";

// Timed-approval record helpers (pure: no DB, no clock).
//
// Contract (extends PR #9's "missed approvals are never a terminal failure"):
// - No timer (timeout_at NULL) = blocking approval. Waits for a human forever.
// - Timer + explicitly configured fallback = when the timer elapses the hub
//   applies that fallback decision on the human's behalf, fully audited.
// - Timer without a fallback = the card is marked timer_state
//   'fallback_required' but STAYS pending: still resolvable by a human, still
//   counted by the approval hold, never a run failure. The hub does not invent
//   a decision — absence of an explicit fallback means "surface, don't decide".

export const APPROVAL_TIMER_FALLBACK_APPLIED = "fallback_applied";
export const APPROVAL_TIMER_FALLBACK_REQUIRED = "fallback_required";

export const APPROVAL_FALLBACK_DECISIONS = new Set(["approved", "rejected", "changes_requested"]);

const MIN_APPROVAL_TIMEOUT_MS = 1_000;
const MAX_APPROVAL_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

// Only an explicit, recognizable decision counts as a configured fallback.
// Anything malformed degrades to null — i.e. the safe "needs fallback" path —
// rather than guessing an approval for a potentially dangerous action.
export function normalizeApprovalFallback(raw) {
  const value = typeof raw === "string" && raw.trim().startsWith("{") ? parseMaybeJson(raw, null) : raw;
  if (typeof value === "string") {
    const decision = value.trim();
    return APPROVAL_FALLBACK_DECISIONS.has(decision) ? { decision, comment: "" } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const decision = String(value.decision || "").trim();
  if (!APPROVAL_FALLBACK_DECISIONS.has(decision)) return null;
  return { decision, comment: String(value.comment || "").slice(0, 500) };
}

// Compute the timer expiry at creation. An explicit timeoutAt wins; otherwise
// timeoutMs is clamped to [1s, 30d] so garbage input cannot create an
// already-elapsed or effectively-infinite timer. Returns null (= blocking
// approval) when neither is usable.
export function approvalTimeoutAtIso({ timeoutMs, timeoutAt, nowMs = Date.now() } = {}) {
  if (timeoutAt != null && timeoutAt !== "") {
    const parsed = Date.parse(timeoutAt);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const clamped = Math.min(Math.max(Math.round(ms), MIN_APPROVAL_TIMEOUT_MS), MAX_APPROVAL_TIMEOUT_MS);
  return new Date(nowMs + clamped).toISOString();
}

// Pending timed approvals whose timer has elapsed and that the sweep has not
// touched yet. Bounded batch so the maintenance tick stays cheap.
export function elapsedTimedApprovalsQuery(nowIso) {
  return {
    sql: `SELECT * FROM approvals
     WHERE status = 'pending' AND timer_state = '' AND timeout_at IS NOT NULL AND timeout_at <= ?
     ORDER BY timeout_at ASC LIMIT 100`,
    params: [nowIso]
  };
}

// Compare-and-swap: only the tick that flips timer_state from '' handles the
// elapse, so two overlapping sweeps (or a human racing the timer) cannot
// double-apply a fallback or double-emit the fallback_required surfacing.
export function approvalTimerElapsedUpdateQuery({ approvalId, timerState, timerElapsedAt }) {
  return {
    sql: "UPDATE approvals SET timer_state=?, timer_elapsed_at=? WHERE id=? AND status='pending' AND timer_state=''",
    params: [timerState, timerElapsedAt, approvalId]
  };
}

export function approvalTimerElapsedMs(approval, nowMs = Date.now()) {
  const createdAt = Date.parse(approval?.createdAt || approval?.created_at || "");
  return Number.isFinite(createdAt) ? Math.max(0, nowMs - createdAt) : 0;
}
