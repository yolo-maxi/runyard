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
// One bounded workflow-code repair per supervised child by default. A repair
// edits the wrapped workflow's own source/template (not a broad refactor) and
// reruns the child exactly once; if the same class of failure repeats we stop
// and escalate to an operator instead of looping.
export const RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS = 1;
export const RUN_SMITHERS_LINEAGE_SCHEMA_VERSION = "smithers.hub.run-smithers.watcher.v1";

// Deterministic workflow-code failures: re-running the same input will not fix
// them, so they are candidates for a one-shot code repair rather than a blind
// retry. These match JS exceptions a workflow template raises and stacks that
// point at workflow source files.
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
  // a stack frame pointing at a workflow source file (.tsx/.ts/.jsx/.js:line:col)
  /\.(?:tsx|ts|jsx|js):\d+:\d+/i
];

// Infra / transient signals that look scary but are NOT deterministic code
// bugs — repairing workflow source would be wrong here; retry/escalate instead.
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

// Classify a child error as a deterministic workflow-code failure. Returns
// { isCodeFailure, kind }. Infra/transient hints win so a flaky network error
// is never mistaken for a code bug.
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
  fingerprintThreshold = RUN_SMITHERS_FINGERPRINT_LIMIT,
  maxCodeRepairs = RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS
} = {}) {
  const normalizedMaxCodeRepairs = Number.isFinite(maxCodeRepairs)
    ? Math.max(0, Math.floor(maxCodeRepairs))
    : RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS;
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
    fingerprintThreshold: Math.max(1, Math.floor(fingerprintThreshold) || RUN_SMITHERS_FINGERPRINT_LIMIT),
    // Workflow-code self-correction accounting. `codeRepairs` is the number of
    // repairs already attempted; `repairedFingerprints` records which error
    // fingerprints we have already tried to repair so we never repair the same
    // failure twice (and never loop).
    maxCodeRepairs: normalizedMaxCodeRepairs,
    codeRepairs: 0,
    repairedFingerprints: {},
    repairs: []
  };
}

// Record that a one-shot workflow-code repair was attempted for the given error
// fingerprint. Callers (the run-smithers template) invoke this after running a
// repair agent + syncing the repaired workflow into the runner workspace, just
// before rerunning the child. Bumps the repair budget so the cap is honoured.
export function recordRepairAttempt(state, repair = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("recordRepairAttempt requires a watcher state");
  }
  const fingerprint = String(repair.fingerprint || state.lastFingerprint || "");
  state.codeRepairs = (state.codeRepairs || 0) + 1;
  if (fingerprint) state.repairedFingerprints[fingerprint] = (state.repairedFingerprints[fingerprint] || 0) + 1;
  const entry = {
    fingerprint,
    file: String(repair.file || ""),
    failedStep: String(repair.failedStep || ""),
    ok: Boolean(repair.ok),
    testPassed: repair.testPassed === undefined ? null : Boolean(repair.testPassed),
    synced: Boolean(repair.synced),
    notes: String(repair.notes || "").slice(0, 600),
    recordedAt: repair.recordedAt || ""
  };
  state.repairs.push(entry);
  return entry;
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

  // Operator cancellations are intent, never a bug — don't repair or auto-resume.
  if (classification.kind === "cancelled") {
    return {
      action: "give_up",
      reason: "child run was cancelled; the supervisor does not auto-resume operator cancellations"
    };
  }

  // Self-correction: a deterministic workflow-code failure (a TypeError, a
  // failed node, a JS stack pointing at workflow source) will not be fixed by
  // re-running the same input. Attempt exactly one bounded code repair for this
  // error fingerprint before falling back to blind retry / approval. This takes
  // priority over the three-strike and maxAttempts escalations so we repair on
  // the *first* code failure instead of burning attempts on a doomed re-run.
  const codeFailure = classifyWorkflowCodeFailure(last?.error || "");
  if (codeFailure.isCodeFailure) {
    const alreadyRepaired = Boolean(fingerprint && state.repairedFingerprints[fingerprint]);
    if (!alreadyRepaired && state.codeRepairs < state.maxCodeRepairs) {
      return {
        action: "repair",
        reason: `Child failed with a deterministic workflow-code error (${codeFailure.kind}); attempting one bounded repair of the workflow source before rerunning.`,
        fingerprint,
        failedStep: last?.failedStep || "",
        capability: state.capabilitySlug,
        error: last?.error || "",
        attempt: state.attempts.length + 1
      };
    }
    // A repair was already attempted for this failure (or the repair budget is
    // exhausted) and the same class of code failure repeated — stop and escalate
    // with a clear artifact instead of looping.
    state.approvalRequested = true;
    return {
      action: "approval",
      escalation: "workflow_code_repair_failed",
      reason: alreadyRepaired
        ? "An automated one-shot workflow-code repair did not resolve the failure; operator review required."
        : "Workflow-code repair budget is exhausted; operator review required.",
      fingerprint,
      count,
      options: [
        {
          id: "retry_anyway",
          label: "Retry the wrapped run once more",
          effect: "spawn another child run with the same input after a manual look at the workflow code"
        },
        {
          id: "edit_and_retry",
          label: "Approve a manual workflow-code fix or revised input",
          effect: "operator fixes the workflow source / supplies a new input; watcher spawns a fresh child run"
        },
        {
          id: "abandon",
          label: "Abandon the wrapped goal",
          effect: "stop autonomous attempts and mark the supervising run needs_recovery"
        }
      ]
    };
  }

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

// Hard gate the supervising wrapper run on a real `succeeded` outcome.
//
// The watcher loop always returns a result object — even when the wrapped child
// repeatedly failed and we escalated to operator approval (`needs_recovery`) or
// burned the attempt budget (`abandoned`). If the workflow simply returned that
// object, the wrapper's local Smithers run would report as `finished` (✓) and
// only the Hub-side runner's outcome-string fallback would convert it to a
// failure. That makes the local wrapper look successful and lets `smithers
// inspect` / the workflow log mask a real supervision failure.
//
// Calling this helper from a second task in `run-smithers.tsx` (after the
// supervise output is persisted) makes the wrapper fail visibly at the workflow
// layer with an actionable message that names the supervised capability, the
// failing outcome, the attempt/repair tally, and the approval state. The
// preceding supervise task still persists the full lineage so operators can
// inspect what happened.
export function assertSupervisionSucceeded(result) {
  const safe = result && typeof result === "object" ? result : {};
  const outcome = String(safe.outcome || "");
  if (outcome === "succeeded") return safe;
  const capability = String(safe.capability || safe.wrappedCapability || "");
  const lineageCount = Array.isArray(safe.lineage) ? safe.lineage.length : 0;
  const repairCount = Array.isArray(safe.repairs) ? safe.repairs.length : 0;
  const codeRepairs = Number.isFinite(safe.codeRepairs) ? safe.codeRepairs : 0;
  const approvalRequested = Boolean(safe.approval) || Boolean(safe.approvalRequested);
  const summary = String(safe.summary || "").slice(0, 600);
  const labelled = capability ? ` of '${capability}'` : "";
  const parts = [
    `run-smithers supervision${labelled} did not reach a 'succeeded' outcome (got '${outcome || "unknown"}').`,
    `attempts=${lineageCount} repairs=${repairCount} codeRepairs=${codeRepairs} approvalRequested=${approvalRequested}.`
  ];
  if (summary) parts.push(`summary: ${summary}`);
  parts.push(
    "Wrapped child runs failed and autonomous recovery (retries + one-shot workflow-code repair) did not finish the goal."
  );
  throw new Error(parts.join(" "));
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
    maxCodeRepairs: state.maxCodeRepairs,
    codeRepairs: state.codeRepairs || 0,
    repairs: (state.repairs || []).map((entry) => ({ ...entry })),
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
