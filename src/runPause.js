// First-class paused runs: a run interrupted by a recoverable external
// condition (credits ran out, provider quota exhausted, an operator parked it)
// is paused — durable, visible, resumable — instead of being failed. Pause is
// deliberately NOT success/failure/cancellation/budget_exceeded/approval-wait:
// budget_exceeded stays the Hub's own hard spend stop, waiting_approval stays
// the human-decision hold. This module owns the pause vocabulary, the
// classifiers that decide pause-vs-fail, and the pause metadata record stored
// in the runs.pause JSON column.
export const PAUSE_REASONS = Object.freeze({
  CREDITS_EXHAUSTED: "credits_exhausted",
  QUOTA_EXHAUSTED: "quota_exhausted",
  PROVIDER_LIMITED: "provider_limited",
  MANUAL: "manual",
  // A resume was attempted but the recorded engine checkpoint could not be
  // used (missing/cleaned local .smithers state). The run re-parks under this
  // reason with the stale checkpoint dropped, so the next resume honestly
  // re-runs from scratch instead of hanging on a pointer that goes nowhere.
  RESUME_FAILED: "resume_failed",
  UNKNOWN: "unknown"
});

const PAUSED_BY_VALUES = new Set(["runner", "hub", "operator", "gateway", "system"]);
const RESUME_STRATEGIES = new Set(["smithers_resume", "rerun_from_scratch", "manual"]);

// Runner-observed error text that clearly means the provider account is out of
// credits/quota — a condition a human fixes by paying, after which the run can
// continue from its checkpoint. Generic 429/rate-limit noise deliberately stays
// OUT of this classifier: transient throttling keeps its existing terminal
// provider_limited classification (src/runFailureClass.js) until Smithers
// exposes a structured retry/pause signal. These patterns are the best
// available adapter today; tighten them as engines emit richer errors.
const CREDIT_EXHAUSTION_RE = /(credit balance is too low|insufficient credits?|out of credits?|purchase more credits|not enough credits?|payment required|\b402\b|billing hard limit)/i;
const QUOTA_EXHAUSTION_RE = /(insufficient_quota|exceeded your current quota|quota exhausted|monthly (?:spend|usage) limit|usage limit reached|spending (?:cap|limit) reached)/i;

export function classifyPauseReason(text) {
  const value = String(text || "");
  if (!value) return null;
  if (CREDIT_EXHAUSTION_RE.test(value)) return PAUSE_REASONS.CREDITS_EXHAUSTED;
  if (QUOTA_EXHAUSTION_RE.test(value)) return PAUSE_REASONS.QUOTA_EXHAUSTED;
  return null;
}

// The metering gateway sees the provider's raw HTTP response — the one
// structured place in the system where "the account has no credits" is a
// status code, not scraped stdout. A 402 from the UPSTREAM provider (never
// from the Hub's own pre-forward budget check, which never reaches here) is a
// credit signal by itself; other statuses only pause when the body text
// clearly says exhausted credits/quota.
export function pauseSignalFromProviderResponse({ status, bodyText = "" } = {}) {
  const body = String(bodyText || "").slice(0, 4000);
  const reason = Number(status) === 402
    ? classifyPauseReason(body) || PAUSE_REASONS.CREDITS_EXHAUSTED
    : classifyPauseReason(body);
  if (!reason) return null;
  return {
    reason,
    message: `Provider returned ${status}: ${snippet(body) || "credit/quota exhausted"}`
  };
}

export function requiredActionForPauseReason(reason) {
  switch (reason) {
    case PAUSE_REASONS.CREDITS_EXHAUSTED:
      return { type: "add_credits", label: "Add credits, then resume" };
    case PAUSE_REASONS.QUOTA_EXHAUSTED:
      return { type: "add_credits", label: "Raise or wait out the provider quota, then resume" };
    case PAUSE_REASONS.PROVIDER_LIMITED:
      return { type: "operator_resume", label: "Wait for the provider limit to clear, then resume" };
    case PAUSE_REASONS.MANUAL:
      return { type: "operator_resume", label: "Resume when ready" };
    case PAUSE_REASONS.RESUME_FAILED:
      return { type: "operator_resume", label: "Resume again to re-run from scratch, or cancel" };
    default:
      return { type: "unknown", label: "Resolve the interruption, then resume" };
  }
}

export function normalizePauseReason(value) {
  const reason = String(value || "").trim().toLowerCase().slice(0, 80);
  return reason || PAUSE_REASONS.UNKNOWN;
}

function normalizePausedBy(value) {
  const pausedBy = String(value || "").trim().toLowerCase();
  return PAUSED_BY_VALUES.has(pausedBy) ? pausedBy : "system";
}

function normalizeResume(resume) {
  if (!resume || typeof resume !== "object") return null;
  const smithersRunId = String(resume.smithersRunId || "").trim();
  const strategy = RESUME_STRATEGIES.has(resume.strategy) ? resume.strategy : (smithersRunId ? "smithers_resume" : undefined);
  const attempt = Number(resume.attempt);
  const normalized = {
    ...(smithersRunId ? { smithersRunId } : {}),
    ...(Number.isFinite(attempt) && attempt > 0 ? { attempt } : {}),
    ...(strategy ? { strategy } : {})
  };
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeRequiredAction(action) {
  if (!action || typeof action !== "object") return null;
  const normalized = {
    ...(action.type ? { type: String(action.type).slice(0, 40) } : {}),
    ...(action.label ? { label: String(action.label).slice(0, 200) } : {}),
    ...(action.href ? { href: String(action.href).slice(0, 500) } : {})
  };
  return Object.keys(normalized).length ? normalized : null;
}

function snippet(text, max = 300) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

// The stored runs.pause record. Additive and backwards-compatible: NULL until
// a run first pauses; resumedAt/resumedBy are stamped on resume so the record
// doubles as pause history on the resumed run.
export function buildRunPause({
  reason,
  message = "",
  pausedBy,
  resumable,
  resume = null,
  requiredAction = null,
  timestamp
} = {}) {
  const normalizedReason = normalizePauseReason(reason);
  const normalizedResume = normalizeResume(resume);
  return {
    reason: normalizedReason,
    ...(snippet(message, 2000) ? { message: snippet(message, 2000) } : {}),
    pausedAt: timestamp,
    pausedBy: normalizePausedBy(pausedBy),
    // Resumable unless the pauser explicitly said otherwise: even without an
    // engine checkpoint the run can be re-queued from scratch (the resume
    // response/event says which strategy applies).
    resumable: resumable !== false,
    ...(normalizedResume ? { resume: normalizedResume } : {}),
    requiredAction: normalizeRequiredAction(requiredAction) || requiredActionForPauseReason(normalizedReason)
  };
}

// Enrich an existing pause record without letting a late/duplicate report
// rewrite history: the first pause's reason/timestamps/action win; the merge
// only fills gaps — most importantly the Smithers checkpoint id the runner
// attaches after it observed a Hub/gateway/operator-initiated pause.
export function mergeRunPause(existing, incoming) {
  const base = existing && typeof existing === "object" ? existing : {};
  const patch = incoming && typeof incoming === "object" ? incoming : {};
  const merged = {
    ...patch,
    ...base,
    ...(base.resume?.smithersRunId ? { resume: base.resume } : patch.resume ? { resume: patch.resume } : {})
  };
  if (!merged.message && patch.message) merged.message = patch.message;
  if ((merged.reason === PAUSE_REASONS.UNKNOWN || !merged.reason) && patch.reason && patch.reason !== PAUSE_REASONS.UNKNOWN) {
    merged.reason = patch.reason;
    merged.requiredAction = patch.requiredAction || requiredActionForPauseReason(patch.reason);
  }
  return merged;
}
