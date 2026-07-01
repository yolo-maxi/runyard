export const RETRYABLE_FAILURE_CLASSES = new Set(["provider_limited", "timed_out", "infra_unavailable"]);
export const NON_RETRYABLE_FAILURE_CLASSES = new Set(["blocked_by_gate", "blocked_by_preflight", "invalid_output", "needs_human"]);

const FAILURE_CLASS_PATTERNS = [
  ["blocked_by_preflight", /\b(preflight|missing workflow|workflow file not found|auth not ready|runner tags|repo path|not writable|no workflow\.entry)\b/i],
  ["blocked_by_gate", /\b(gate failed|test failed|lint failed|typecheck failed|build failed|verification failed|eval failed)\b/i],
  ["provider_limited", /\b(429|rate limit|rate-limit|quota|usage limit|provider limited|temporarily overloaded)\b/i],
  ["timed_out", /\b(timeout|timed out|deadline exceeded|exceeded runner deadline|etimedout)\b/i],
  ["invalid_output", /\b(invalid output|schema|zod|json parse|structured output|expected .* got|missing required)\b/i],
  ["infra_unavailable", /\b(enospc|econnrefused|econnreset|network|dns|host unavailable|runner offline|runner heartbeat expired|spawn failed|enoent)\b/i],
  ["needs_human", /\b(needs human|operator approval|approval required|manual review|human required)\b/i]
];

const WORKFLOW_CODE_FAILURE_PATTERNS = [
  /\btypeerror\b/i,
  /\breferenceerror\b/i,
  /\bsyntaxerror\b/i,
  /\brangeerror\b/i,
  /cannot read propert(?:y|ies)/i,
  /is not a function/i,
  /is not defined/i,
  /is not iterable/i,
  /(?:undefined|null) is not an object/i,
  /cannot access '[^']*' before initialization/i,
  /unexpected (?:token|identifier|end of)/i,
  /\.(?:tsx|ts|jsx|js):\d+:\d+/i
];

const NON_CODE_FAILURE_HINTS = [
  /\benospc\b/i,
  /\benomem\b/i,
  /\beacces\b/i,
  /\betimedout\b/i,
  /\beconnreset\b/i,
  /\beconnrefused\b/i,
  /\benotfound\b/i,
  /\benetwork\b/i,
  /timed?\s?out/i,
  /deadline/i,
  /rate.?limit/i,
  /out of memory/i,
  /no space left/i,
  /pnpm (?:install|store)/i,
  /npm install/i
];

const VOLATILE_PATTERNS = [
  /\brun_[a-f0-9]{6,}\b/gi,
  /\bappr_[a-f0-9]{6,}\b/gi,
  /\bartf?_[a-f0-9]{6,}\b/gi,
  /\d{4}-\d{2}-\d{2}t[0-9:.zZ]+/gi,
  /\b[0-9a-f]{12,}\b/gi,
  /\b\d{6,}\b/g,
  /\bhttps?:\/\/\S+/gi,
  /\/[^\s'"`)]+/g
];

const RECOVERABLE_CHECKPOINT_KEYS = ["checkpoint", "lastCheckpoint", "resumeFrom", "resumeStep"];

export function classifyFailureClass({ status = "", error = "" } = {}) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (RETRYABLE_FAILURE_CLASSES.has(normalizedStatus) || NON_RETRYABLE_FAILURE_CLASSES.has(normalizedStatus)) return normalizedStatus;
  const text = String(error || "");
  for (const [failureClass, pattern] of FAILURE_CLASS_PATTERNS) {
    if (pattern.test(text)) return failureClass;
  }
  return "failed";
}

// Infra/transient hints win so a flaky environment issue is never mistaken for
// a deterministic workflow-code bug that should trigger source repair.
export function classifyWorkflowCodeFailure(message) {
  const text = String(message ?? "");
  if (!text.trim()) return { isCodeFailure: false, kind: "" };
  for (const hint of NON_CODE_FAILURE_HINTS) {
    if (hint.test(text)) return { isCodeFailure: false, kind: "infra" };
  }
  for (const pattern of WORKFLOW_CODE_FAILURE_PATTERNS) {
    if (pattern.test(text)) return { isCodeFailure: true, kind: "workflow_code" };
  }
  return { isCodeFailure: false, kind: "" };
}

export function normalizeErrorFingerprint(message) {
  let text = String(message ?? "").trim().toLowerCase();
  if (!text) return "";
  for (const pattern of VOLATILE_PATTERNS) text = text.replace(pattern, "*");
  text = text.replace(/[^a-z0-9 :_*\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 160 ? text.slice(0, 160) : text;
}

function pickCheckpoint(run) {
  if (!run || typeof run !== "object") return null;
  for (const key of RECOVERABLE_CHECKPOINT_KEYS) {
    if (run[key]) return run[key];
  }
  const input = run.input || {};
  if (input && typeof input === "object") {
    if (input.__checkpoint) return input.__checkpoint;
    if (input.checkpoint) return input.checkpoint;
  }
  return null;
}

export function classifyChildState(run = null) {
  if (!run || !run.status) {
    return { kind: "unknown", terminal: false, recoverable: false, promotedSuccess: false };
  }
  const status = String(run.status);
  if (status === "succeeded") {
    const promoted = run.output !== undefined && run.output !== null;
    return {
      kind: "succeeded",
      terminal: true,
      recoverable: false,
      promotedSuccess: promoted
    };
  }
  if (status === "failed") {
    const checkpoint = pickCheckpoint(run);
    return {
      kind: checkpoint ? "failed_recoverable" : "failed_terminal",
      terminal: true,
      recoverable: Boolean(checkpoint),
      promotedSuccess: false,
      checkpoint: checkpoint || null
    };
  }
  if (NON_RETRYABLE_FAILURE_CLASSES.has(status)) {
    return { kind: status, terminal: true, recoverable: false, promotedSuccess: false, failureClass: status };
  }
  if (RETRYABLE_FAILURE_CLASSES.has(status)) {
    return { kind: status, terminal: true, recoverable: false, promotedSuccess: false, retryable: true, failureClass: status };
  }
  if (status === "cancelled") {
    return { kind: "cancelled", terminal: true, recoverable: false, promotedSuccess: false };
  }
  if (status === "waiting_approval") {
    return { kind: "waiting_approval", terminal: false, recoverable: false, promotedSuccess: false };
  }
  if (status === "queued" || status === "assigned" || status === "running") {
    return { kind: "running", terminal: false, recoverable: false, promotedSuccess: false };
  }
  return { kind: status, terminal: false, recoverable: false, promotedSuccess: false };
}
