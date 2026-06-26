// Hub-as-Supervisor decision brain.
//
// Supervision used to live *in-band*: the `run-smithers` envelope ran on a
// runner and wrapped a child run on the same runner. When the runner process
// died, the supervisor died with the very run it was supposed to rescue. This
// module relocates the *decision* up into the hub's singleton reconcile loop
// (the reaper) so it survives the death of any individual runner process.
//
// It is intentionally side-effect free and DB-free: callers (the reaper in
// src/db.js) extract the durable facts about a run (its failure reason, error,
// resumable checkpoint, attempt/repair counters, loop-breaker progress marker)
// and pass them in; this module returns the decision. That keeps it unit
// testable and lets it reuse the already-correct classify/fingerprint brain
// from src/runSmithersWatcher.js instead of reinventing it.

import {
  classifyWorkflowCodeFailure,
  normalizeErrorFingerprint,
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  RUN_SMITHERS_FINGERPRINT_LIMIT
} from "./runSmithersWatcher.js";

// How many times the hub will resume a run that keeps failing with the *same*
// fingerprint and makes no forward progress before it gives up and escalates.
// This is the loop-breaker: it bounds auto-resume independently of maxAttempts
// so a run that is silently re-dying at the same spot can never resume forever.
export const HUB_DEFAULT_MAX_RESUMES_PER_FINGERPRINT = 2;

export const HUB_SUPERVISOR_DECISION_SCHEMA = "smithers.hub.supervisor.decision.v1";

export const HUB_DEFAULT_CAPS = Object.freeze({
  maxAttempts: RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  maxCodeRepairs: RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  fingerprintThreshold: RUN_SMITHERS_FINGERPRINT_LIMIT,
  maxResumesPerFingerprint: HUB_DEFAULT_MAX_RESUMES_PER_FINGERPRINT
});

export { classifyWorkflowCodeFailure, normalizeErrorFingerprint };

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

// Decide what the hub reconcile loop should do with a single orphaned or
// failed-recoverable run. Pure function — no DB, no clock, no I/O.
//
// Inputs (all extracted by the caller from durable run state):
//   reason        — why the run is being adjudicated:
//                     'runner_offline' (ORPHANED — runner confirmed dead),
//                     'failed'         (FAILED-RECOVERABLE — runner self-reported),
//                     'run_stalled' | 'max_runtime' (hung-but-maybe-alive).
//   error         — the run's recorded error string (for classify + fingerprint).
//   checkpoint    — the resumable substrate handle (the prior smithers run id)
//                   or null. No checkpoint ⇒ nothing to resume from.
//   cancelledIntent — operator cancellation: intent, never auto-resumed.
//   resumeSafe    — false marks a step the workflow declared non-resumable; the
//                   hub escalates rather than blind-resume (brief §8).
//   attempt       — resume attempts already spent on this run.
//   repairCount   — code repairs already spent on this run.
//   repairedFingerprints — { [fingerprint]: count } already repaired (cap 1/fp).
//   fingerprintResumes   — { [fingerprint]: count } resumes spent per fingerprint.
//   progressMarker        — a monotonic measure of forward progress (e.g. the
//                           run's event count) at this failure.
//   lastProgressMarker    — the progressMarker recorded at the previous resume.
//   enableRepair  — Phase 2 toggle: allow hub-side code repair dispatch.
//   caps          — { maxAttempts, maxCodeRepairs, fingerprintThreshold,
//                     maxResumesPerFingerprint }.
//
// Returns: { action, reason, fingerprint, ... }
//   action 'resume'   — requeue to resume from checkpoint.
//   action 'repair'   — dispatch a one-shot code repair, then resume (Phase 2).
//   action 'escalate' — surface an operator approval card (caps/loop-breaker).
//   action 'give_up'  — terminal fail (no checkpoint / cancelled / unsafe).
export function decideReconcile(ctx = {}) {
  const caps = { ...HUB_DEFAULT_CAPS, ...(ctx.caps || {}) };
  const maxAttempts = intOr(caps.maxAttempts, HUB_DEFAULT_CAPS.maxAttempts) || HUB_DEFAULT_CAPS.maxAttempts;
  const maxCodeRepairs = intOr(caps.maxCodeRepairs, HUB_DEFAULT_CAPS.maxCodeRepairs);
  const fingerprintThreshold =
    intOr(caps.fingerprintThreshold, HUB_DEFAULT_CAPS.fingerprintThreshold) || HUB_DEFAULT_CAPS.fingerprintThreshold;
  const maxResumesPerFingerprint =
    intOr(caps.maxResumesPerFingerprint, HUB_DEFAULT_CAPS.maxResumesPerFingerprint) ||
    HUB_DEFAULT_CAPS.maxResumesPerFingerprint;

  const reason = String(ctx.reason || "failed");
  const error = String(ctx.error || "");
  const fingerprint = normalizeErrorFingerprint(error);
  const attempt = intOr(ctx.attempt, 0);
  const repairCount = intOr(ctx.repairCount, 0);
  const repairedFingerprints = ctx.repairedFingerprints && typeof ctx.repairedFingerprints === "object" ? ctx.repairedFingerprints : {};
  const fingerprintResumes = ctx.fingerprintResumes && typeof ctx.fingerprintResumes === "object" ? ctx.fingerprintResumes : {};
  const checkpoint = ctx.checkpoint || null;

  const base = { schema: HUB_SUPERVISOR_DECISION_SCHEMA, fingerprint, attempt, reasonClass: reason };

  // Operator cancellation is intent, not failure — never auto-resume it.
  if (ctx.cancelledIntent) {
    return { ...base, action: "give_up", reason: "run was cancelled by an operator; supervisor does not auto-resume cancellations" };
  }

  // A hung-but-possibly-alive runner (stall / deadline) must NOT be blind
  // resumed: the original smithers process may still be executing on a live
  // runner and re-dispatch would double-run committed side effects. These fail
  // terminally exactly as before; only a confirmed-dead runner (runner_offline)
  // or a self-reported failure is safe to resume.
  if (reason === "run_stalled" || reason === "max_runtime") {
    return { ...base, action: "give_up", reason: `run ${reason} on a possibly-live runner; terminal fail (not safe to blind-resume)` };
  }

  // No resumable substrate ⇒ there is nothing to resume *from*. Terminal fail
  // (this is the "without a checkpoint → fails terminally" gate).
  if (!checkpoint) {
    return { ...base, action: "give_up", reason: "no recoverable checkpoint recorded; terminal fail" };
  }

  // The workflow declared the current step non-resumable (an uncommitted side
  // effect that re-running would duplicate). Prefer escalate-to-human over a
  // blind resume (brief §8 resume-safety).
  if (ctx.resumeSafe === false) {
    return {
      ...base,
      action: "escalate",
      escalation: "non_resumable_step",
      reason: "run failed at a step the workflow marked non-resumable; operator review required before any resume"
    };
  }

  // Hard attempt cap — escalate to an operator instead of resuming forever.
  if (attempt >= maxAttempts) {
    return {
      ...base,
      action: "escalate",
      escalation: "max_attempts",
      reason: `reached maxAttempts (${maxAttempts}) without success; operator review required`
    };
  }

  // Loop-breaker: same fingerprint, resumed maxResumesPerFingerprint times, and
  // no forward progress since the last resume (the progress marker did not
  // advance) ⇒ stop, escalate. Never infinite-resume a run that re-dies in the
  // same place. Forward progress (a larger marker) implicitly resets this by
  // letting the count-vs-progress check pass.
  const fpResumes = fingerprint ? intOr(fingerprintResumes[fingerprint], 0) : 0;
  const progressMarker = intOr(ctx.progressMarker, 0);
  const lastProgressMarker = intOr(ctx.lastProgressMarker, 0);
  const madeProgress = progressMarker > lastProgressMarker;
  if (fingerprint && fpResumes >= maxResumesPerFingerprint && !madeProgress) {
    return {
      ...base,
      action: "escalate",
      escalation: "loop_breaker",
      reason: `same error fingerprint resumed ${fpResumes} times with no forward progress; pausing autonomous resume`
    };
  }

  // Phase 2 — deterministic workflow-code bug: dispatch one bounded repair for
  // this fingerprint (never twice) before resuming. Takes priority over the
  // three-strike escalation so we repair on the first code failure rather than
  // burning resumes on a doomed re-run.
  const codeFailure = classifyWorkflowCodeFailure(error);
  if (ctx.enableRepair && codeFailure.isCodeFailure) {
    const alreadyRepaired = Boolean(fingerprint && repairedFingerprints[fingerprint]);
    if (!alreadyRepaired && repairCount < maxCodeRepairs) {
      return {
        ...base,
        action: "repair",
        codeFailureKind: codeFailure.kind,
        reason: `deterministic workflow-code failure (${codeFailure.kind}); dispatching one bounded repair before resume`
      };
    }
    // Repair already tried for this fingerprint (or budget spent) and the same
    // class of code failure repeated — escalate rather than loop.
    return {
      ...base,
      action: "escalate",
      escalation: "code_repair_exhausted",
      reason: alreadyRepaired
        ? "automated code repair did not resolve the failure; operator review required"
        : "code-repair budget exhausted; operator review required"
    };
  }

  // Three-strike rule: the same normalized fingerprint observed
  // fingerprintThreshold times (counting this resume attempt) without forward
  // progress ⇒ escalate instead of another blind resume.
  if (fingerprint && fpResumes + 1 >= fingerprintThreshold && !madeProgress) {
    return {
      ...base,
      action: "escalate",
      escalation: "three_strike",
      reason: `same error fingerprint observed ${fpResumes + 1} times without progress; pausing autonomous retry`
    };
  }

  // Transient / infra failure with a checkpoint and budget left → resume from
  // the recorded checkpoint on the shared workspace.
  return {
    ...base,
    action: "resume",
    nextAttempt: attempt + 1,
    reason: codeFailure.kind === "infra"
      ? "transient/infra failure with a recoverable checkpoint; resuming from recorded state"
      : "recoverable failure with a checkpoint and budget remaining; resuming from recorded state"
  };
}

// Build the standard operator approval payload for an escalation decision so the
// reaper and the dashboard render a consistent self-heal card with concrete
// options. Pure helper.
export function buildEscalationApproval(run, decision) {
  const runId = run?.id || "";
  const capability = run?.capability_slug || run?.capabilitySlug || "";
  return {
    title: `Supervisor escalation: ${capability || runId}`.slice(0, 240),
    description: (decision?.reason || "Autonomous recovery exhausted; operator review required.").slice(0, 2000),
    payload: {
      kind: "supervisor_escalation",
      approvalKind: "supervisor_escalation",
      escalation: decision?.escalation || "exhausted",
      runId,
      capability,
      fingerprint: decision?.fingerprint || "",
      attempt: decision?.attempt ?? null,
      options: [
        { id: "retry_anyway", label: "Resume once more", effect: "re-queue the run to resume from its last checkpoint despite the cap" },
        { id: "edit_and_retry", label: "Fix and resume", effect: "operator repairs the workflow / input, then resumes" },
        { id: "abandon", label: "Abandon the run", effect: "stop autonomous recovery and leave the run failed" }
      ]
    }
  };
}
