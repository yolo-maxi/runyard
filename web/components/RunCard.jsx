import { deepLinks } from "../lib/router.js";
import {
  isActiveRun, isDiagnosticRun, runTitle, runDescription, runProject, runBranch,
  runExecutionLabel, runDurationMs, formatDuration, relativeTime, truncate,
  artifactDisplayName, formatBytes
} from "../lib/runHelpers.js";
import { rerunRun, editRerunById } from "../lib/runActions.js";
import { Icon, StatusBadge, ShareButton, OverflowMenu } from "./ui.jsx";
import { RunProgressStrip } from "./RunProgressStrip.jsx";

function QueueBanner({ run }) {
  const position = run?.queue?.position;
  const total = run?.queue?.total;
  const detail = position
    ? `#${position}${total ? ` of ${total}` : ""} · waiting for a runner slot`
    : "waiting for a runner slot";
  return (
    <p className="run-queue-banner" title="This run is queued — a runner with matching tags will pick it up next.">
      <span className="run-queue-icon" aria-hidden="true">⏳</span>
      <span className="run-queue-text">In queue</span>
      <span className="run-queue-detail muted">{detail}</span>
    </p>
  );
}

// One run summary card. Ported from legacy runCard(). Driven by the live run
// object so its status/progress update reactively as the collection refetches.
export function RunCard({ run, artifacts = [], now = Date.now() }) {
  const active = isActiveRun(run);
  const slug = run.capabilitySlug || "";
  const title = runTitle(run);
  const description = runDescription(run);
  const project = runProject(run);
  const branch = runBranch(run);
  const origin = run.originLabel || run.origin?.label || "unknown origin";
  const execution = runExecutionLabel(run);
  const durStr = formatDuration(runDurationMs(run, now));
  const created = relativeTime(run.createdAt, now);
  const reasonHint = isDiagnosticRun(run) ? run.reasonHint || "" : "";
  const showFailureBlock = (run.status === "failed" || run.status === "error") && (reasonHint || run.failedStep);
  const showArtifacts = !active && artifacts.length > 0;

  return (
    <article className={`run-card ${active ? "active" : "done"} ${run.status}`} id={`run-${run.id}`}>
      <header className="run-card-head">
        <div className="run-card-status">
          {active ? <span className="run-pulse" aria-hidden="true" /> : null}
          <StatusBadge value={run.status} />
        </div>
        <ShareButton hash={deepLinks.run(run.id)} label="Copy share link to this run" />
      </header>
      <h3 className="run-card-title">
        <a href={deepLinks.run(run.id)}>{title}</a>
      </h3>
      <p className="run-card-sub">
        {slug ? (
          <a className="run-cap-link" href={deepLinks.workflow(slug)} title="Open this workflow">
            {run.capabilityName || slug}
          </a>
        ) : null}
        <span className="run-origin" title="Origin">{origin}</span>
      </p>
      <p className="muted run-desc">{description}</p>
      <RunProgressStrip run={run} now={now} />
      {run.status === "queued" ? <QueueBanner run={run} /> : null}
      {project || branch || run.workflowVersion || execution ? (
        <div className="run-card-chips">
          {project ? <span className="chip chip-project" title="Project / target"><Icon name="project" /> {project}</span> : null}
          {branch ? <span className="chip chip-branch" title="Branch"><Icon name="branch" /> {branch}</span> : null}
          {run.workflowVersion ? <span className="chip chip-version" title="Workflow version">v{run.workflowVersion}</span> : null}
          {execution ? <span className="chip chip-runner" title="Execution target">{execution}</span> : null}
        </div>
      ) : null}
      {reasonHint ? (
        <p className="run-reason-hint" title={reasonHint}>⚠ <span>{truncate(reasonHint, 140)}</span></p>
      ) : null}
      {showFailureBlock ? (
        <div className="run-card-failure" aria-label="Failure detail">
          <div className="run-card-failure-row">
            {run.failedStep ? <span className="run-card-failure-step" title="Failing step">step {run.failedStep}</span> : null}
            {run.failureType ? <code className="diagnostics-event-type">{run.failureType}</code> : null}
          </div>
          {reasonHint ? <div className="run-card-failure-cause">{truncate(reasonHint, 140)}</div> : null}
          <a className="run-card-failure-link" href={deepLinks.runLogs(run.id)}>Open timeline →</a>
        </div>
      ) : null}
      <p className="muted run-meta">
        <span className="run-step">{run.currentStep || (active ? "starting…" : "—")}</span>
        <span className="run-timing">{created}{durStr ? ` · ${durStr}` : ""}</span>
      </p>
      {showArtifacts ? (
        <ul className="artifact-list">
          {artifacts.slice(0, 3).map((a) => (
            <li key={a.id}>
              <a href={deepLinks.artifact(a)}>{artifactDisplayName(a)}</a>{" "}
              <a className="muted artifact-dl" href={`/api/artifacts/${a.id}/download`} target="_blank" rel="noreferrer">download</a>{" "}
              <span className="muted">{formatBytes(a.sizeBytes)}</span>
            </li>
          ))}
          {artifacts.length > 3 ? (
            <li className="muted"><a href={deepLinks.runArtifacts(run.id)}>+{artifacts.length - 3} more</a></li>
          ) : null}
        </ul>
      ) : null}
      <footer className="run-card-foot">
        {/* One clear action per card; everything secondary collapses into the
            overflow menu so the runs grid stays calm. The card title and the
            workflow chip above already link to detail / the workflow. */}
        <button className="btn-sm" onClick={() => rerunRun(run.id)}>Re-run</button>
        <OverflowMenu
          size="sm"
          label="More run actions"
          items={[
            { label: "Edit & re-run", onSelect: () => editRerunById(run.id) },
            { label: "Run log", href: deepLinks.runLogs(run.id) },
            { label: "Artifacts", href: deepLinks.runArtifacts(run.id) }
          ]}
        />
      </footer>
    </article>
  );
}
