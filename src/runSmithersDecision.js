import {
  classifyWorkflowCodeFailure,
  NON_RETRYABLE_FAILURE_CLASSES
} from "./runSmithersClassification.js";

const NON_RETRYABLE_OPTIONS = [
  {
    id: "fix_precondition",
    label: "Fix the precondition, gate, or input",
    effect: "operator fixes the missing dependency/auth/input/gate failure, then starts a fresh run"
  },
  {
    id: "retry_anyway",
    label: "Retry once anyway",
    effect: "operator explicitly accepts a retry despite the non-retryable class"
  },
  {
    id: "abandon",
    label: "Abandon the wrapped goal",
    effect: "stop autonomous attempts and mark the supervising run needs_recovery"
  }
];

const REPAIR_FAILED_OPTIONS = [
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
];

const FINGERPRINT_ESCALATION_OPTIONS = [
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
];

const MAX_ATTEMPTS_OPTIONS = [
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
];

const NON_RESUMABLE_CHILD_STEPS = new Set(["commit", "push", "deploy", "hooks", "stalled", "timed out"]);

function latestAttemptContext(state, classification) {
  const last = state.attempts[state.attempts.length - 1] || null;
  const fingerprint = last?.fingerprint || "";
  return {
    last,
    fingerprint,
    count: fingerprint ? state.fingerprintCounts[fingerprint] : 0,
    failureClass: last?.failureClass || classification.failureClass || "failed"
  };
}

function nonResumableChildFailure({ last } = {}) {
  const failedStep = String(last?.failedStep || "").trim().toLowerCase();
  const error = String(last?.error || "");
  if (NON_RESUMABLE_CHILD_STEPS.has(failedStep)) {
    return {
      escalation: failedStep === "stalled" || failedStep === "timed out" ? "possibly_live_child" : "non_resumable_child_step",
      reason:
        failedStep === "stalled" || failedStep === "timed out"
          ? "Child run was marked stalled/timed out; it may still have live process or git side effects, so the wrapper must not auto-retry."
          : `Child failed at '${failedStep}', after the workflow may have produced external side effects; operator review required before retry.`
    };
  }
  if (/run emitted no events within the stall window|run exceeded execution deadline/i.test(error)) {
    return {
      escalation: "possibly_live_child",
      reason: "Child run was marked stalled/timed out; it may still have live process or git side effects, so the wrapper must not auto-retry."
    };
  }
  if (/failed at node ['"](?:commit|push|deploy)['"]/i.test(error)) {
    return {
      escalation: "non_resumable_child_step",
      reason: "Child failed at a non-resumable git/deploy step; operator review required before retry."
    };
  }
  return null;
}

function approval(state, payload) {
  state.approvalRequested = true;
  return { action: "approval", ...payload };
}

function codeRepairDecision(state, { last, fingerprint, count }) {
  const codeFailure = classifyWorkflowCodeFailure(last?.error || "");
  if (!codeFailure.isCodeFailure) return null;
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
  return approval(state, {
    escalation: "workflow_code_repair_failed",
    reason: alreadyRepaired
      ? "An automated one-shot workflow-code repair did not resolve the failure; operator review required."
      : "Workflow-code repair budget is exhausted; operator review required.",
    fingerprint,
    count,
    options: REPAIR_FAILED_OPTIONS
  });
}

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
  if (classification.kind === "cancelled") {
    return {
      action: "give_up",
      reason: "child run was cancelled; the supervisor does not auto-resume operator cancellations"
    };
  }

  const context = latestAttemptContext(state, classification);
  if (NON_RETRYABLE_FAILURE_CLASSES.has(context.failureClass)) {
    return approval(state, {
      escalation: "non_retryable_failure_class",
      reason: `Child ended as ${context.failureClass}; not retrying a deterministic/operator-gated failure automatically.`,
      fingerprint: context.fingerprint,
      count: context.count,
      failureClass: context.failureClass,
      options: NON_RETRYABLE_OPTIONS
    });
  }

  const nonResumable = nonResumableChildFailure(context);
  if (nonResumable) {
    return approval(state, {
      escalation: nonResumable.escalation,
      reason: nonResumable.reason,
      fingerprint: context.fingerprint,
      count: context.count,
      failureClass: context.failureClass,
      failedStep: context.last?.failedStep || "",
      options: FINGERPRINT_ESCALATION_OPTIONS
    });
  }

  const repairDecision = codeRepairDecision(state, context);
  if (repairDecision) return repairDecision;

  if (context.fingerprint && context.count >= state.fingerprintThreshold) {
    return approval(state, {
      reason: `Same normalized error fingerprint observed ${context.count} times; pausing autonomous retry.`,
      fingerprint: context.fingerprint,
      count: context.count,
      options: FINGERPRINT_ESCALATION_OPTIONS
    });
  }

  if (state.attempts.length >= state.maxAttempts) {
    return approval(state, {
      reason: `Reached maxAttempts (${state.maxAttempts}) without a promoted success.`,
      fingerprint: context.fingerprint,
      count: context.count,
      options: MAX_ATTEMPTS_OPTIONS
    });
  }

  if (classification.recoverable) {
    return {
      action: "retry",
      reason: "child failed at a recoverable checkpoint; resuming from recorded state",
      checkpoint: context.last?.checkpoint || classification.checkpoint || null,
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
