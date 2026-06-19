// run-smithers watcher — pure, deterministic helpers used by the supervising
// `run-smithers` capability to wrap a child workflow request. The watcher
// records child lineage (run ids, capabilities, checkpoints, failed steps,
// recovery attempts, normalized error fingerprints, final outcome), classifies
// child run state, and decides what to do next while honoring the three-strike
// approval rule.
//
// This module is intentionally side-effect free so tests can drive it
// deterministically. Callers (the Hub, a runner, or the workflow template) own
// child-run creation, polling, and approval surfaces — the watcher only owns
// the decision and lineage shape.

export const RUN_SMITHERS_FINGERPRINT_LIMIT = 3;
export const RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS = 8;
export const RUN_SMITHERS_LINEAGE_SCHEMA_VERSION = "smithers.hub.run-smithers.watcher.v1";

// Volatile fragments that change every attempt (ids, timestamps, paths,
// long hex). Stripping them makes the normalized fingerprint match across
// re-runs of the same underlying error.
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

// Classify the supervised child run. `terminal` means the child has reached a
// terminal status; `recoverable` means we can spawn a retry that resumes from
// recorded state; `promotedSuccess` means the child reached the only state we
// accept as success (a real `succeeded` with output).
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

export function createWatcherState({
  goal = "",
  capabilitySlug = "",
  input = {},
  parentRunId = "",
  maxAttempts = RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  fingerprintThreshold = RUN_SMITHERS_FINGERPRINT_LIMIT
} = {}) {
  return {
    schemaVersion: RUN_SMITHERS_LINEAGE_SCHEMA_VERSION,
    parentRunId,
    goal,
    capabilitySlug,
    inputKeys: input && typeof input === "object" ? Object.keys(input).slice(0, 32) : [],
    attempts: [],
    fingerprintCounts: {},
    lastFingerprint: "",
    outcome: null,
    approvalRequested: false,
    maxAttempts: Math.max(1, Math.floor(maxAttempts) || RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS),
    fingerprintThreshold: Math.max(1, Math.floor(fingerprintThreshold) || RUN_SMITHERS_FINGERPRINT_LIMIT)
  };
}

// Record a child run attempt onto the watcher state. Callers should call this
// once per child terminal transition (or when escalating after a stuck
// interrupted run). It returns the recorded entry so callers can correlate it
// with approval payloads or events.
export function recordChildAttempt(state, attempt = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("recordChildAttempt requires a watcher state");
  }
  const fingerprint = normalizeErrorFingerprint(attempt.error || attempt.failureReason || "");
  const entry = {
    runId: attempt.runId || "",
    capability: attempt.capability || state.capabilitySlug || "",
    status: attempt.status || "unknown",
    error: String(attempt.error || attempt.failureReason || "").slice(0, 600),
    failedStep: attempt.failedStep || attempt.currentStep || "",
    checkpoint: attempt.checkpoint || null,
    fingerprint,
    recordedAt: attempt.recordedAt || ""
  };
  state.attempts.push(entry);
  if (fingerprint) {
    state.fingerprintCounts[fingerprint] = (state.fingerprintCounts[fingerprint] || 0) + 1;
    state.lastFingerprint = fingerprint;
  } else {
    state.lastFingerprint = "";
  }
  return entry;
}

// Decide the next watcher action given the latest child classification. The
// returned shape is the contract the workflow template/runtime consumes.
export function decideNextAction(state, childClassification = null) {
  if (!state || typeof state !== "object") {
    throw new TypeError("decideNextAction requires a watcher state");
  }
  if (state.outcome === "succeeded") {
    return { action: "succeed", reason: "child workflow already reached promoted success" };
  }
  if (state.approvalRequested) {
    return {
      action: "approval",
      reason: "approval already requested; awaiting operator decision",
      fingerprint: state.lastFingerprint,
      count: state.fingerprintCounts[state.lastFingerprint] || 0
    };
  }
  const classification = childClassification || { kind: "unknown", terminal: false };
  if (classification.terminal && classification.promotedSuccess) {
    state.outcome = "succeeded";
    return { action: "succeed", reason: "child workflow reached promoted/success terminal state" };
  }
  if (classification.kind === "waiting_approval") {
    return { action: "wait_approval", reason: "child run is paused for an operator decision" };
  }
  if (!classification.terminal) {
    return { action: "observe", reason: "child run still in progress" };
  }

  const last = state.attempts[state.attempts.length - 1] || null;
  const fingerprint = last?.fingerprint || "";
  const count = fingerprint ? state.fingerprintCounts[fingerprint] : 0;

  // Three-strike rule: if the same normalized fingerprint has been observed
  // `fingerprintThreshold` times, stop autonomous retry and surface an
  // approval with concrete options instead of marking the run failed.
  if (fingerprint && count >= state.fingerprintThreshold) {
    state.approvalRequested = true;
    return {
      action: "approval",
      reason: `Same normalized error fingerprint observed ${count} times; pausing autonomous retry.`,
      fingerprint,
      count,
      options: [
        {
          id: "retry_anyway",
          label: "Retry once more with the same input",
          effect: "spawn another child run with the same input and reset the fingerprint counter once"
        },
        {
          id: "edit_and_retry",
          label: "Approve a revised input or recovery plan",
          effect: "operator supplies a new input or resume step; watcher spawns a fresh child run"
        },
        {
          id: "abandon",
          label: "Abandon the wrapped goal",
          effect: "stop autonomous attempts and mark the supervising run needs_recovery"
        }
      ]
    };
  }

  if (state.attempts.length >= state.maxAttempts) {
    state.approvalRequested = true;
    return {
      action: "approval",
      reason: `Reached maxAttempts (${state.maxAttempts}) without a promoted success.`,
      fingerprint,
      count,
      options: [
        {
          id: "retry_anyway",
          label: "Raise the attempt budget and try again",
          effect: "operator raises maxAttempts; watcher resumes autonomous retry"
        },
        {
          id: "abandon",
          label: "Abandon the wrapped goal",
          effect: "stop autonomous attempts and mark the supervising run needs_recovery"
        }
      ]
    };
  }

  if (classification.kind === "cancelled") {
    return {
      action: "give_up",
      reason: "child run was cancelled; the supervisor does not auto-resume operator cancellations"
    };
  }

  if (classification.recoverable) {
    return {
      action: "retry",
      reason: "child failed at a recoverable checkpoint; resuming from recorded state",
      checkpoint: last?.checkpoint || classification.checkpoint || null,
      attempt: state.attempts.length + 1
    };
  }

  return {
    action: "retry",
    reason: "child failed without a recoverable checkpoint; retrying within budget",
    checkpoint: null,
    attempt: state.attempts.length + 1
  };
}

export function watcherSummary(state) {
  if (!state || typeof state !== "object") return null;
  const fingerprintLeaders = Object.entries(state.fingerprintCounts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([fingerprint, count]) => ({ fingerprint, count }));
  return {
    schemaVersion: state.schemaVersion || RUN_SMITHERS_LINEAGE_SCHEMA_VERSION,
    parentRunId: state.parentRunId || "",
    capabilitySlug: state.capabilitySlug || "",
    goal: state.goal || "",
    attempts: state.attempts.length,
    maxAttempts: state.maxAttempts,
    fingerprintThreshold: state.fingerprintThreshold,
    outcome: state.outcome,
    approvalRequested: Boolean(state.approvalRequested),
    fingerprintLeaders,
    lineage: (state.attempts || []).map((entry) => ({
      runId: entry.runId,
      capability: entry.capability,
      status: entry.status,
      failedStep: entry.failedStep,
      fingerprint: entry.fingerprint,
      checkpoint: entry.checkpoint,
      recordedAt: entry.recordedAt
    }))
  };
}
