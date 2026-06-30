export const RUN_FAILURE_CLASSES = Object.freeze({
  FAILED: "failed",
  BLOCKED_BY_GATE: "blocked_by_gate",
  BLOCKED_BY_PREFLIGHT: "blocked_by_preflight",
  PROVIDER_LIMITED: "provider_limited",
  TIMED_OUT: "timed_out",
  INVALID_OUTPUT: "invalid_output",
  INFRA_UNAVAILABLE: "infra_unavailable",
  NEEDS_HUMAN: "needs_human"
});

export const RUN_FAILURE_TERMINAL_STATUSES = new Set(Object.values(RUN_FAILURE_CLASSES));

const CLASS_PATTERNS = [
  [RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT, /\b(preflight|missing workflow|workflow file not found|auth not ready|runner tags|repo path|not writable|no workflow\.entry)\b/i],
  [RUN_FAILURE_CLASSES.BLOCKED_BY_GATE, /\b(gate failed|test failed|lint failed|typecheck failed|build failed|verification failed|eval failed)\b/i],
  [RUN_FAILURE_CLASSES.PROVIDER_LIMITED, /\b(429|rate limit|rate-limit|quota|usage limit|provider limited|temporarily overloaded)\b/i],
  [RUN_FAILURE_CLASSES.TIMED_OUT, /\b(timeout|timed out|deadline exceeded|exceeded runner deadline|etimedout)\b/i],
  [RUN_FAILURE_CLASSES.INVALID_OUTPUT, /\b(invalid output|schema|zod|json parse|structured output|expected .* got|missing required)\b/i],
  [RUN_FAILURE_CLASSES.INFRA_UNAVAILABLE, /\b(enospc|econnrefused|econnreset|network|dns|host unavailable|runner offline|runner heartbeat expired|spawn failed|enoent)\b/i],
  [RUN_FAILURE_CLASSES.NEEDS_HUMAN, /\b(needs human|operator approval|approval required|manual review|human required)\b/i]
];

export function normalizeFailureStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return RUN_FAILURE_TERMINAL_STATUSES.has(status) ? status : RUN_FAILURE_CLASSES.FAILED;
}

export function classifyFailureStatus(error = "", fallback = RUN_FAILURE_CLASSES.FAILED) {
  const text = String(error || "");
  for (const [status, pattern] of CLASS_PATTERNS) {
    if (pattern.test(text)) return status;
  }
  return normalizeFailureStatus(fallback);
}

export function failureEventType(status) {
  const normalized = normalizeFailureStatus(status);
  return normalized === RUN_FAILURE_CLASSES.FAILED ? "run.failed" : `run.${normalized}`;
}
