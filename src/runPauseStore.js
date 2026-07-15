import { buildRunPause, mergeRunPause } from "./runPause.js";

// Domain operations behind POST /api/runs/:id/pause + /resume and the metering
// gateway's provider-402 hook. Pausing releases the runner slot (the paused
// run must not occupy capacity while a human replenishes credits) and resume
// re-queues the SAME run, carrying the recorded Smithers checkpoint back to
// the runner through the existing input.__resume launch path.
// Strategies a resume caller may force. Omitting the strategy resolves
// automatically: checkpointed when a Smithers checkpoint is recorded,
// from-scratch otherwise. Forcing rerun_from_scratch is the operator escape
// hatch for a stale checkpoint or a retired/offline pinned runner.
const REQUESTABLE_RESUME_STRATEGIES = new Set(["smithers_resume", "rerun_from_scratch"]);

export function createRunPauseStore({ getRun, getRunner = () => null, transitionRun, updateRun, addRunEvent, now }) {
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

  function resumeRun(runId, { resumedBy = "operator", strategy = "" } = {}) {
    const current = getRun(runId);
    if (!current) return { ok: false, code: 404, error: "run not found" };
    if (current.status !== "paused") {
      return { ok: false, code: 409, error: `cannot resume run from '${current.status}'; only paused runs resume` };
    }
    if (current.pause && current.pause.resumable === false) {
      return { ok: false, code: 409, error: "run was paused as not resumable; cancel it or re-run instead" };
    }

    const requested = String(strategy || "").trim();
    if (requested && !REQUESTABLE_RESUME_STRATEGIES.has(requested)) {
      return { ok: false, code: 400, error: `unknown resume strategy '${requested}'; use 'smithers_resume', 'rerun_from_scratch', or omit it for automatic selection` };
    }
    const smithersRunId = String(current.pause?.resume?.smithersRunId || "").trim();
    if (requested === "smithers_resume" && !smithersRunId) {
      return { ok: false, code: 409, error: "no engine checkpoint is recorded on this run; resume without a strategy (or with 'rerun_from_scratch') to re-run from scratch" };
    }
    const useCheckpoint = Boolean(smithersRunId) && requested !== "rerun_from_scratch";
    const attempt = (Number(current.pause?.resume?.attempt) || Number(current.input?.__resume?.attempt) || 0) + 1;
    const input = { ...(current.input || {}) };
    if (useCheckpoint) input.__resume = { smithersRunId, attempt };
    else delete input.__resume;

    // runner_id: a checkpointed resume KEEPS the pin — the Smithers checkpoint
    // lives on that runner's local .smithers state, and the claim query pins
    // runs with a runner_id to the same runner (src/runRecords.js
    // runClaimAssignmentQuery). A from-scratch resume CLEARS it so any live
    // runner can claim; discarding the checkpoint is exactly the escape hatch
    // for a retired or offline pinned runner.
    const result = transitionRun(runId, "queued", {
      current_step: "queued",
      input,
      pause: { ...(current.pause || {}), resumedAt: now(), resumedBy },
      ...(useCheckpoint ? {} : { runner_id: null })
    });
    if (!result.ok) return result;

    const resume = { strategy: useCheckpoint ? "smithers_resume" : "rerun_from_scratch", ...(useCheckpoint ? { smithersRunId } : {}), attempt };
    // A checkpointed resume only executes once the pinned runner claims it.
    // Say so up front when that runner is offline, instead of leaving the run
    // silently queued behind a heartbeat that may never come back.
    let warning = "";
    if (useCheckpoint && current.runnerId) {
      const runner = getRunner(current.runnerId);
      if (!runner || !runner.online) {
        resume.runnerOnline = false;
        resume.runnerId = current.runnerId;
        warning = `runner ${current.runnerId} holding the checkpoint is offline; the run stays queued until that runner reconnects — resume again with strategy 'rerun_from_scratch' to run on any runner (discards the checkpoint)`;
      }
    }
    const message = useCheckpoint
      ? `Run resumed from Smithers checkpoint ${smithersRunId} (attempt ${attempt})${warning ? `; ${warning}` : ""}`
      : smithersRunId
        ? `Run resumed from scratch by request (attempt ${attempt}); the recorded checkpoint ${smithersRunId} was discarded and the runner pin cleared`
        : "Run resumed with no engine checkpoint; it will re-run from scratch";
    addRunEvent(runId, "run.resumed", message, {
      ...resume,
      resumedBy,
      ...(warning ? { warning } : {})
    });
    return { ...result, resume, ...(warning ? { warning } : {}) };
  }

  return { pauseRun, resumeRun };
}
