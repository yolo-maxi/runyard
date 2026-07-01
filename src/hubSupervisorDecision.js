import {
  classifyWorkflowCodeFailure,
  normalizeErrorFingerprint
} from "./runSmithersClassification.js";
import {
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  RUN_SMITHERS_FINGERPRINT_LIMIT
} from "./runSmithersPolicy.js";

export const HUB_DEFAULT_MAX_RESUMES_PER_FINGERPRINT = 2;
export const HUB_SUPERVISOR_DECISION_SCHEMA = "smithers.hub.supervisor.decision.v1";

export const HUB_DEFAULT_CAPS = Object.freeze({
  maxAttempts: RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  maxCodeRepairs: RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  fingerprintThreshold: RUN_SMITHERS_FINGERPRINT_LIMIT,
  maxResumesPerFingerprint: HUB_DEFAULT_MAX_RESUMES_PER_FINGERPRINT
});

const CONFIG_FAILURE_RE = new RegExp(
  [
    "needs\\s+[A-Z_]*TOKEN",
    "needs\\s+[A-Z_]+\\s+on the runner",
    "\\b[A-Z_]*HUB_TOKEN\\b.*\\b(required|missing|not set)\\b",
    "command not found",
    "\\bENOENT\\b",
    "is not installed",
    "not found in (\\$)?PATH"
  ].join("|"),
  "i"
);

export function classifyConfigFailure(error) {
  const text = String(error || "");
  return { isConfigFailure: text.length > 0 && CONFIG_FAILURE_RE.test(text) };
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function reconcileCaps(caps = {}) {
  const merged = { ...HUB_DEFAULT_CAPS, ...caps };
  return {
    maxAttempts: intOr(merged.maxAttempts, HUB_DEFAULT_CAPS.maxAttempts) || HUB_DEFAULT_CAPS.maxAttempts,
    maxCodeRepairs: intOr(merged.maxCodeRepairs, HUB_DEFAULT_CAPS.maxCodeRepairs),
    fingerprintThreshold:
      intOr(merged.fingerprintThreshold, HUB_DEFAULT_CAPS.fingerprintThreshold) || HUB_DEFAULT_CAPS.fingerprintThreshold,
    maxResumesPerFingerprint:
      intOr(merged.maxResumesPerFingerprint, HUB_DEFAULT_CAPS.maxResumesPerFingerprint) ||
      HUB_DEFAULT_CAPS.maxResumesPerFingerprint
  };
}

export function decideReconcile(ctx = {}) {
  const caps = reconcileCaps(ctx.caps);
  const reason = String(ctx.reason || "failed");
  const error = String(ctx.error || "");
  const fingerprint = normalizeErrorFingerprint(error);
  const attempt = intOr(ctx.attempt, 0);
  const repairCount = intOr(ctx.repairCount, 0);
  const repairedFingerprints = ctx.repairedFingerprints && typeof ctx.repairedFingerprints === "object" ? ctx.repairedFingerprints : {};
  const fingerprintResumes = ctx.fingerprintResumes && typeof ctx.fingerprintResumes === "object" ? ctx.fingerprintResumes : {};
  const checkpoint = ctx.checkpoint || null;

  const base = { schema: HUB_SUPERVISOR_DECISION_SCHEMA, fingerprint, attempt, reasonClass: reason };

  if (ctx.cancelledIntent) {
    return { ...base, action: "give_up", reason: "run was cancelled by an operator; supervisor does not auto-resume cancellations" };
  }
  if (reason === "run_stalled" || reason === "max_runtime") {
    return { ...base, action: "give_up", reason: `run ${reason} on a possibly-live runner; terminal fail (not safe to blind-resume)` };
  }
  if (classifyConfigFailure(error).isConfigFailure) {
    return {
      ...base,
      action: "escalate",
      escalation: "runner_misconfig",
      reason: "runner environment/config failure (e.g. missing hub token or agent binary); resume can't fix it — operator must correct the runner config/image"
    };
  }
  if (!checkpoint) {
    return { ...base, action: "give_up", reason: "no recoverable checkpoint recorded; terminal fail" };
  }
  if (ctx.resumeSafe === false) {
    return {
      ...base,
      action: "escalate",
      escalation: "non_resumable_step",
      reason: "run failed at a step the workflow marked non-resumable; operator review required before any resume"
    };
  }
  if (attempt >= caps.maxAttempts) {
    return {
      ...base,
      action: "escalate",
      escalation: "max_attempts",
      reason: `reached maxAttempts (${caps.maxAttempts}) without success; operator review required`
    };
  }

  const fpResumes = fingerprint ? intOr(fingerprintResumes[fingerprint], 0) : 0;
  const progressMarker = intOr(ctx.progressMarker, 0);
  const lastProgressMarker = intOr(ctx.lastProgressMarker, 0);
  const madeProgress = progressMarker > lastProgressMarker;
  if (fingerprint && fpResumes >= caps.maxResumesPerFingerprint && !madeProgress) {
    return {
      ...base,
      action: "escalate",
      escalation: "loop_breaker",
      reason: `same error fingerprint resumed ${fpResumes} times with no forward progress; pausing autonomous resume`
    };
  }

  const codeFailure = classifyWorkflowCodeFailure(error);
  if (ctx.enableRepair && codeFailure.isCodeFailure) {
    const alreadyRepaired = Boolean(fingerprint && repairedFingerprints[fingerprint]);
    if (!alreadyRepaired && repairCount < caps.maxCodeRepairs) {
      return {
        ...base,
        action: "repair",
        codeFailureKind: codeFailure.kind,
        reason: `deterministic workflow-code failure (${codeFailure.kind}); dispatching one bounded repair before resume`
      };
    }
    return {
      ...base,
      action: "escalate",
      escalation: "code_repair_exhausted",
      reason: alreadyRepaired
        ? "automated code repair did not resolve the failure; operator review required"
        : "code-repair budget exhausted; operator review required"
    };
  }

  if (fingerprint && fpResumes + 1 >= caps.fingerprintThreshold && !madeProgress) {
    return {
      ...base,
      action: "escalate",
      escalation: "three_strike",
      reason: `same error fingerprint observed ${fpResumes + 1} times without progress; pausing autonomous retry`
    };
  }

  return {
    ...base,
    action: "resume",
    nextAttempt: attempt + 1,
    reason: codeFailure.kind === "infra"
      ? "transient/infra failure with a recoverable checkpoint; resuming from recorded state"
      : "recoverable failure with a checkpoint and budget remaining; resuming from recorded state"
  };
}

export { classifyWorkflowCodeFailure, normalizeErrorFingerprint };
