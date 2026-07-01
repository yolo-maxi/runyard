import { RUN_FAILURE_CLASSES } from "./runFailureClass.js";
import { productiveOutcomeFailure, runSmithersSupervisionFailure } from "./runnerPolicy.js";
import { smithersChangeSummary } from "./runnerSmithersArtifacts.js";
import { extractSmithersFailure } from "./smithersFailure.js";

export function smithersRunOutcome({
  capability,
  state,
  sid,
  outputs = {},
  inspect = {},
  eventLines = [],
  deadlineExceeded = false,
  maxRunMs = 0
}) {
  const supervisionFailure = state === "succeeded" ? runSmithersSupervisionFailure(capability, outputs) : "";
  const outcomeFailure = state === "succeeded" && !supervisionFailure ? productiveOutcomeFailure(capability, outputs) : null;

  if (state === "succeeded" && !supervisionFailure && !outcomeFailure) {
    // Stamp the same `changeSummary` block we write to smithers-output.json onto
    // the persisted run envelope so hub UI consumers and external readers of
    // `run.output` see the real changed-file count directly, instead of having
    // to re-derive it from per-node keys. Older runs without this field stay
    // graceful — `runOutcomeSummary` still walks `outputs`.
    return {
      ok: true,
      output: { smithersRunId: sid, outputs, changeSummary: smithersChangeSummary(outputs) }
    };
  }

  if (supervisionFailure) return { ok: false, error: supervisionFailure, status: "" };
  if (outcomeFailure) return { ok: false, error: outcomeFailure.error, status: outcomeFailure.status };
  if (deadlineExceeded) {
    return {
      ok: false,
      error: `smithers run ${sid} exceeded runner deadline (${maxRunMs}ms) and was cancelled`,
      status: RUN_FAILURE_CLASSES.TIMED_OUT
    };
  }

  const failure = extractSmithersFailure(inspect, eventLines);
  const error = failure.error
    ? `smithers run ${sid} failed${failure.failedStep ? ` at node '${failure.failedStep}'` : ""}: ${failure.error}`.slice(0, 2000)
    : `smithers run ${sid} ended in state '${state}'`;
  return { ok: false, error, status: "" };
}
