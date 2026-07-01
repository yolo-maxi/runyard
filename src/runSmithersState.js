import {
  classifyFailureClass,
  normalizeErrorFingerprint
} from "./runSmithersClassification.js";
import {
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  RUN_SMITHERS_FINGERPRINT_LIMIT,
  RUN_SMITHERS_LINEAGE_SCHEMA_VERSION
} from "./runSmithersPolicy.js";

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
// fingerprint. Callers invoke this after running a repair agent + syncing the
// repaired workflow into the runner workspace, just before rerunning the child.
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
// interrupted run).
export function recordChildAttempt(state, attempt = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("recordChildAttempt requires a watcher state");
  }
  const fingerprint = normalizeErrorFingerprint(attempt.error || attempt.failureReason || "");
  const failureClass = classifyFailureClass({ status: attempt.status, error: attempt.error || attempt.failureReason || "" });
  const entry = {
    runId: attempt.runId || "",
    capability: attempt.capability || state.capabilitySlug || "",
    status: attempt.status || "unknown",
    error: String(attempt.error || attempt.failureReason || "").slice(0, 600),
    failedStep: attempt.failedStep || attempt.currentStep || "",
    checkpoint: attempt.checkpoint || null,
    failureClass,
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
      failureClass: entry.failureClass || "",
      failedStep: entry.failedStep,
      fingerprint: entry.fingerprint,
      checkpoint: entry.checkpoint,
      recordedAt: entry.recordedAt
    }))
  };
}
