import { buildRunPause, mergeRunPause } from "./runPause.js";

// Domain operations behind POST /api/runs/:id/pause + /resume and the metering
// gateway's provider-402 hook. Pausing releases the runner slot (the paused
// run must not occupy capacity while a human replenishes credits) and resume
// re-queues the SAME run, carrying the recorded Smithers checkpoint back to
// the runner through the existing input.__resume launch path.
export function createRunPauseStore({ getRun, transitionRun, updateRun, addRunEvent, now }) {
  function pauseRun(runId, spec = {}) {
    const current = getRun(runId);
    if (!current) return { ok: false, code: 404, error: "run not found" };

    // Already paused: treat as an enrichment, not a conflict. The main case is
    // the owning runner attaching the Smithers checkpoint after it observed a
    // pause initiated by the Hub/gateway/operator.
    if (current.status === "paused") {
      const merged = mergeRunPause(current.pause, buildRunPause({ ...spec, timestamp: current.pause?.pausedAt || now() }));
      const gainedCheckpoint = !current.pause?.resume?.smithersRunId && merged.resume?.smithersRunId;
      const run = updateRun(runId, { pause: merged });
      if (gainedCheckpoint) {
        addRunEvent(runId, "run.pause_updated", `Recorded resume checkpoint ${merged.resume.smithersRunId}`, {
          smithersRunId: merged.resume.smithersRunId
        });
      }
      return { ok: true, idempotent: true, run };
    }

    const pause = buildRunPause({ ...spec, timestamp: now() });
    const result = transitionRun(runId, "paused", { current_step: "paused", pause });
    if (!result.ok || result.idempotent) return result;
    addRunEvent(runId, "run.paused", pause.message || `Run paused (${pause.reason})`, {
      reason: pause.reason,
      pausedBy: pause.pausedBy,
      resumable: pause.resumable,
      ...(pause.resume?.smithersRunId ? { smithersRunId: pause.resume.smithersRunId } : {}),
      ...(pause.requiredAction ? { requiredAction: pause.requiredAction } : {})
    });
    return result;
  }

  function resumeRun(runId, { resumedBy = "operator" } = {}) {
    const current = getRun(runId);
    if (!current) return { ok: false, code: 404, error: "run not found" };
    if (current.status !== "paused") {
      return { ok: false, code: 409, error: `cannot resume run from '${current.status}'; only paused runs resume` };
    }
    if (current.pause && current.pause.resumable === false) {
      return { ok: false, code: 409, error: "run was paused as not resumable; cancel it or re-run instead" };
    }

    const smithersRunId = String(current.pause?.resume?.smithersRunId || "").trim();
    const strategy = smithersRunId ? "smithers_resume" : "rerun_from_scratch";
    const attempt = (Number(current.pause?.resume?.attempt) || Number(current.input?.__resume?.attempt) || 0) + 1;
    const input = { ...(current.input || {}) };
    if (smithersRunId) input.__resume = { smithersRunId, attempt };
    else delete input.__resume;

    // runner_id is intentionally KEPT: the Smithers checkpoint lives on that
    // runner's local .smithers state, and the claim query pins runs with a
    // runner_id to the same runner (src/runRecords.js runClaimAssignmentQuery).
    const result = transitionRun(runId, "queued", {
      current_step: "queued",
      input,
      pause: { ...(current.pause || {}), resumedAt: now(), resumedBy }
    });
    if (!result.ok) return result;
    const resume = { strategy, ...(smithersRunId ? { smithersRunId } : {}), attempt };
    addRunEvent(runId, "run.resumed", smithersRunId
      ? `Run resumed from Smithers checkpoint ${smithersRunId} (attempt ${attempt})`
      : "Run resumed with no engine checkpoint; it will re-run from scratch", {
      ...resume,
      resumedBy
    });
    return { ...result, resume };
  }

  return { pauseRun, resumeRun };
}
