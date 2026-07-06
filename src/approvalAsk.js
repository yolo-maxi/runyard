// The first-class "ask contract" for approvals.
//
// An approval is a declared question with a declared consequence. The ask is
// what the *creator* of a card must state up front — who is being asked, what
// exactly happens on approve, why a human is needed, and (optionally) which
// named options exist. Surfaces render the stored ask verbatim; they never
// re-derive it from input-key archaeology. Cards created before this contract
// (or by callers that don't supply one yet) have ask=null and fall back to a
// heuristic ask that is explicitly marked `derived: true`.
import { truncate } from "./presentation.js";

// Who is expected to answer. Enforcement is a later branch (verb parity /
// scopes); today the audience is displayed so "who is being asked" stops being
// unanswerable. `operators` is the default: anyone operating runs.
export const APPROVAL_ASK_AUDIENCES = ["operators", "admins"];

const ACTION_MAX = 500;
const REASON_MAX = 500;
const OPTION_TEXT_MAX = 200;
const MAX_OPTIONS = 8;

function cleanString(value, max) {
  return truncate(typeof value === "string" ? value : "", max);
}

export function normalizeApprovalAskOption(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanString(raw.id, 60);
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return null;
  return {
    id,
    label: cleanString(raw.label, OPTION_TEXT_MAX) || id,
    effect: cleanString(raw.effect, OPTION_TEXT_MAX)
  };
}

// Normalize a creator-supplied ask. Returns null when the ask is absent or
// does not state both an action and a reason — the two fields without which a
// card cannot answer "what happens" and "why me". Callers treat null as
// "no ask declared" (the card is flagged, never silently invented).
export function normalizeApprovalAsk(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = cleanString(raw.action, ACTION_MAX);
  const reason = cleanString(raw.reason, REASON_MAX);
  if (!action || !reason) return null;
  const audience = APPROVAL_ASK_AUDIENCES.includes(raw.audience) ? raw.audience : "operators";
  const options = Array.isArray(raw.options)
    ? raw.options.slice(0, MAX_OPTIONS).map(normalizeApprovalAskOption).filter(Boolean)
    : [];
  return {
    audience,
    action,
    reason,
    ...(options.length ? { options } : {})
  };
}

// True when a card has no stored ask — surfaces show it with a derived
// fallback and (on detail views) may badge it as incomplete.
export function approvalAskIncomplete(approval) {
  return !normalizeApprovalAsk(approval?.ask);
}

export function humanizeApprovalAudience(audience) {
  if (audience === "admins") return "Admins";
  if (audience === "operators") return "Anyone operating runs";
  return audience || "Anyone operating runs";
}
