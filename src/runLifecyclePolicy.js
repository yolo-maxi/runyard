import { RUN_FAILURE_TERMINAL_STATUSES } from "./runFailureClass.js";

export const RUN_TERMINAL = new Set(["succeeded", "cancelled", ...RUN_FAILURE_TERMINAL_STATUSES]);

const RUN_TRANSITIONS = {
  waiting_approval: ["queued", "cancelled"],
  queued: ["assigned", "running", "cancelled", ...RUN_FAILURE_TERMINAL_STATUSES],
  assigned: ["running", "succeeded", "cancelled", ...RUN_FAILURE_TERMINAL_STATUSES],
  running: ["succeeded", "cancelled", ...RUN_FAILURE_TERMINAL_STATUSES],
  succeeded: [],
  failed: [],
  blocked_by_gate: [],
  blocked_by_preflight: [],
  provider_limited: [],
  timed_out: [],
  invalid_output: [],
  infra_unavailable: [],
  needs_human: [],
  cancelled: []
};

export function canTransitionRun(from, to) {
  if (from === to) return true;
  return (RUN_TRANSITIONS[from] || []).includes(to);
}

export function runTransitionDecision(current, toStatus) {
  if (!current) return { ok: false, code: 404, error: "run not found" };
  if (current.status === toStatus && RUN_TERMINAL.has(toStatus)) {
    return { ok: true, idempotent: true };
  }
  // Late terminal-vs-terminal reports lose to the first terminal state. This
  // preserves operator/deadline intent and avoids noisy 409s from slow writers.
  if (RUN_TERMINAL.has(current.status) && RUN_TERMINAL.has(toStatus)) {
    return { ok: true, idempotent: true, raced: true };
  }
  if (!canTransitionRun(current.status, toStatus)) {
    return {
      ok: false,
      code: 409,
      error: `cannot transition run from '${current.status}' to '${toStatus}'`
    };
  }
  return { ok: true, idempotent: false };
}

export function shouldReleaseRunnerSlotOnTransition(current, toStatus) {
  return Boolean(
    RUN_TERMINAL.has(toStatus)
    && current?.runnerId
    && (current.status === "assigned" || current.status === "running")
  );
}
