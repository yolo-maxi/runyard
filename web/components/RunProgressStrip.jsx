import { runPhaseStates, runPhaseDurations, formatDuration } from "../lib/runHelpers.js";

// Three-phase Queued → Running → Done/Failed strip. Pure component driven by
// the live `run` object — when the runs collection refetches, React re-renders
// this in place, so no manual DOM-replacement poll loop is needed (the legacy
// pollActiveRunProgress is gone). `now` ticks live phase durations.
function PhaseDuration({ state, dur, now }) {
  if (!dur || state === "pending") return null;
  if (dur.liveStart != null) {
    return (
      <span className="run-progress-phase-duration" data-live-start={String(dur.liveStart)}>
        {formatDuration(Math.max(0, now - dur.liveStart))}
      </span>
    );
  }
  if (dur.ms != null) {
    return <span className="run-progress-phase-duration">{formatDuration(dur.ms)}</span>;
  }
  return null;
}

export function RunProgressStrip({ run, now = Date.now() }) {
  const phases = runPhaseStates(run, now);
  const durations = runPhaseDurations(run);
  const outcomeLabel =
    phases.outcome === "ok" ? "Done" : phases.outcome === "fail" ? "Failed" : phases.outcome === "cancel" ? "Cancelled" : "Done";
  // A run paused on a human decision must never read as "Running".
  const runningLabel =
    run?.status === "waiting_approval" ? "Waiting for approval" : phases.running === "stalled" ? "Stalled" : "Running";
  const items = [
    { key: "queued", label: "Queued", state: phases.queued, dur: durations.queued },
    { key: "running", label: runningLabel, state: phases.running, dur: durations.running },
    { key: "outcome", label: outcomeLabel, state: phases.outcome, dur: durations.outcome }
  ];
  return (
    <ol className="run-progress-strip" data-run-progress={run?.id || ""} aria-label="Run progress">
      {items.map((p) => (
        <li key={p.key} className={`run-progress-phase phase-${p.state}`} data-phase={p.key}>
          <span className="run-progress-dot" aria-hidden="true" />
          <span className="run-progress-label">{p.label}</span>
          <PhaseDuration state={p.state} dur={p.dur} now={now} />
        </li>
      ))}
      {run?.currentStep ? (
        <span className="run-progress-step-name muted" title="Current step">
          {run.currentStep}
        </span>
      ) : null}
    </ol>
  );
}
