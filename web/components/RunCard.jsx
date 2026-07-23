import { deepLinks } from "../lib/router.js";
import {
  isActiveRun, isDiagnosticRun, runTitle, runDescription, runProject, runBranch,
  runExecutionLabel, runDurationMs, formatDuration, relativeTime, truncate, runStatusLabel,
  artifactDisplayName, formatBytes, runChangedFiles, runChurn, runDigest, runUsageChip,
  runBudgetChip, pauseReasonLabel
} from "../lib/runHelpers.js";
import { rerunRun, editRerunById } from "../lib/runActions.js";
import { promoteRun, runPromotionCandidate } from "../lib/runPromotion.js";
import { runAutomation } from "../lib/provenance.js";
import { Icon, StatusBadge, ShareButton, OverflowMenu, CodeChurn } from "./ui.jsx";
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

function runSignal(run, reasonHint, active) {
  if (run.failedStep && reasonHint) return `Failed step: ${run.failedStep} · ${truncate(reasonHint, 120)}`;
  if (run.failedStep) return `Failed step: ${run.failedStep}`;
  if (reasonHint) return truncate(reasonHint, 140);
  if (run.currentStep) return active ? run.currentStep : `Last step: ${run.currentStep}`;
  return active ? "starting…" : "No step detail";
}

function RunActions({ run, size = "sm" }) {
  const promotion = runPromotionCandidate(run);
  return (
    <>
      {promotion.available ? (
        <button className="btn-sm primary" title={`Merge ${promotion.sourceBranch} into ${promotion.targetBranch}`} onClick={() => promoteRun(run.id)}>
          <Icon name="branch" /> Merge to main
        </button>
      ) : null}
      <button className="btn-sm" onClick={() => rerunRun(run.id)}>Re-run</button>
      <OverflowMenu
        size={size}
        label="More run actions"
        items={[
          { label: "Edit & re-run", onSelect: () => editRerunById(run.id) },
          { label: "Run log", href: deepLinks.runLogs(run.id) },
          { label: "Artifacts", href: deepLinks.runArtifacts(run.id) }
        ]}
      />
    </>
  );
}

// One run summary card. Ported from legacy runCard(). Driven by the live run
// object so its status/progress update reactively as the collection refetches.
export function RunCard({ run, artifacts = [], now = Date.now(), variant = "card" }) {
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
  const reasonHint = isDiagnosticRun(run) ? run.reasonHint || run.error || run.failureType || "" : "";
  const showFailureBlock = (run.status === "failed" || run.status === "error") && (reasonHint || run.failedStep);
  const showArtifacts = !active && artifacts.length > 0;
  const signal = runSignal(run, reasonHint, active);
  const changed = runChangedFiles(run);
  const churn = runChurn(run);
  const digest = runDigest(run);
  const usageChip = runUsageChip(run);
  // Paused and near-/over-budget runs carry their own list chips: the status
  // badge alone reads as "in flight", but these runs need a human next.
  const pausedChip = run.status === "paused"
    ? { label: pauseReasonLabel(run.pause?.reason), title: run.pause?.message || "Paused — resume from the run page" }
    : null;
  const budgetChip = runBudgetChip(run);
  const automation = runAutomation(run);
  // Hover-tooltip the actual file list on the "N files" chip when the outcome
  // summary carries specifics; otherwise the count still renders so the runs
  // history reflects that files did change.
  const changedTitle = changed
    ? changed.files.length
      ? `${changed.count} changed file${changed.count === 1 ? "" : "s"}:\n${changed.files.join("\n")}`
      : `${changed.count} changed file${changed.count === 1 ? "" : "s"}`
    : "";

  if (variant === "row") {
    // Active runs share the same grid layout as historical ones — only the
    // status badge, a left accent stripe, and an inline pulse distinguish them.
    // Artifacts/duration metadata is suppressed for in-flight rows because they
    // don't have stable values yet; "elapsed" is shown in their place.
    const showArtifactLink = !active;
    return (
      <article
        className={`run-history-row ${run.status}${active ? " active" : ""}`}
        id={`run-${run.id}`}
        data-active={active ? "true" : "false"}
      >
        <div className="run-history-status">
          {active ? <span className="run-pulse run-pulse-row" aria-hidden="true" /> : null}
          <StatusBadge value={run.status} label={runStatusLabel(run.status)} />
        </div>
        <div className="run-history-main">
          <h3 className="run-history-title">
            <a href={deepLinks.run(run.id)}>{title}</a>
          </h3>
          <p className="run-history-sub">
            {slug ? (
              <a className="run-cap-link" href={deepLinks.workflow(slug)} title="Open this workflow">
                {run.capabilityName || slug}
              </a>
            ) : null}
            <span className="run-origin" title="Origin">{origin}</span>
            {automation ? <AutomationBadge automation={automation} /> : null}
          </p>
          <p className="run-history-signal" title={reasonHint || run.currentStep || ""}>{signal}</p>
        </div>
        <div className="run-history-chips" aria-label="Run context">
          {project ? <span className="chip chip-project" title="Project / target"><Icon name="project" /> {project}</span> : null}
          {branch ? <span className="chip chip-branch" title="Branch"><Icon name="branch" /> {branch}</span> : null}
          {changed ? <span className="chip chip-files" title={changedTitle}>{changed.count} file{changed.count === 1 ? "" : "s"}</span> : null}
          {churn ? <CodeChurn churn={churn} /> : null}
          {usageChip ? <span className="chip chip-usage" title="Metered model usage (tokens · estimated cost)">{usageChip}</span> : null}
          {pausedChip ? <span className="chip chip-paused" title={pausedChip.title}>⏸ {pausedChip.label}</span> : null}
          {budgetChip ? <span className={`chip chip-budget chip-budget-${budgetChip.tone}`} title="Spend budget (spent vs limit) — see the run page for numbers">{budgetChip.label}</span> : null}
        </div>
        <div className="run-history-meta">
          <span title={run.createdAt || ""}>{created}</span>
          {durStr ? <span>{active ? `${durStr} elapsed` : durStr}</span> : null}
          {showArtifactLink ? (
            <a href={deepLinks.runArtifacts(run.id)}>{artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}</a>
          ) : null}
        </div>
        <div className="run-history-actions">
          <ShareButton hash={deepLinks.run(run.id)} label="Copy share link to this run" />
          <RunActions run={run} />
        </div>
        {digest ? (
          <p className="run-history-digest" title={digest}>{truncate(digest, 200)}</p>
        ) : null}
      </article>
    );
  }

  return (
    <article className={`run-card ${active ? "active" : "done"} ${run.status}`} id={`run-${run.id}`}>
      <header className="run-card-head">
        <div className="run-card-status">
          {active ? <span className="run-pulse" aria-hidden="true" /> : null}
          <StatusBadge value={run.status} label={runStatusLabel(run.status)} />
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
        {automation ? <AutomationBadge automation={automation} /> : null}
      </p>
      <p className="muted run-desc">{description}</p>
      <RunProgressStrip run={run} now={now} />
      {run.status === "queued" ? <QueueBanner run={run} /> : null}
      {project || branch || run.workflowVersion || execution || churn || changed || usageChip || pausedChip || budgetChip ? (
        <div className="run-card-chips">
          {project ? <span className="chip chip-project" title="Project / target"><Icon name="project" /> {project}</span> : null}
          {branch ? <span className="chip chip-branch" title="Branch"><Icon name="branch" /> {branch}</span> : null}
          {run.workflowVersion ? <span className="chip chip-version" title="Workflow version">v{run.workflowVersion}</span> : null}
          {execution ? <span className="chip chip-runner" title="Execution target">{execution}</span> : null}
          {changed ? <span className="chip chip-files" title={changedTitle}>{changed.count} file{changed.count === 1 ? "" : "s"}</span> : null}
          {churn ? <CodeChurn churn={churn} /> : null}
          {usageChip ? <span className="chip chip-usage" title="Metered model usage (tokens · estimated cost)">{usageChip}</span> : null}
          {pausedChip ? <span className="chip chip-paused" title={pausedChip.title}>⏸ {pausedChip.label}</span> : null}
          {budgetChip ? <span className={`chip chip-budget chip-budget-${budgetChip.tone}`} title="Spend budget (spent vs limit) — see the run page for numbers">{budgetChip.label}</span> : null}
        </div>
      ) : null}
      {digest ? (
        <p className="run-card-digest" title={digest}>{truncate(digest, 240)}</p>
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
        <RunActions run={run} />
      </footer>
    </article>
  );
}

function AutomationBadge({ automation }) {
  const title = automation.scheduleName
    ? `Scheduled automation: ${automation.scheduleName}${automation.trigger ? ` (${automation.trigger})` : ""}`
    : "Scheduled automation";
  const label = automation.scheduleName ? `Scheduled: ${automation.scheduleName}` : "Scheduled";
  return automation.deepLink ? (
    <a className="chip chip-automation" href={automation.deepLink} title={title}>{label}</a>
  ) : (
    <span className="chip chip-automation" title={title}>{label}</span>
  );
}
