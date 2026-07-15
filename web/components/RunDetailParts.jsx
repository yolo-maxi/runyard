import { deepLinks } from "../lib/router.js";
import { copyText } from "../lib/clipboard.js";
import {
  isActiveRun, runDurationMs, formatDuration, relativeTime, formatTimestamp,
  artifactDisplayName, formatBytes, truncate, runStatusLabel, runUsage, formatTokens, formatCostMicros,
  pauseReasonLabel
} from "../lib/runHelpers.js";
import { rerunRun, editRerunRun, cancelRun, pauseRun, resumeRun } from "../lib/runActions.js";
import { promoteRun, runPromotionCandidate } from "../lib/runPromotion.js";
import { StatusBadge, ShareButton, Icon, JsonBlock, CodeChurn } from "./ui.jsx";

const FAILURE_STATUSES = new Set(["failed", "error", "cancelled", "rejected", "budget_exceeded"]);

// Outcome-first banner. Ported from runOutcomeBanner().
export function RunBanner({ run, diagnostics, title, slug, onChanged }) {
  const statusKey = String(run.status || "").toLowerCase();
  const isFailure = FAILURE_STATUSES.has(statusKey);
  const durStr = formatDuration(runDurationMs(run));
  const headline = isFailure && diagnostics?.headline
    ? String(diagnostics.headline).split(/\r?\n/).find((l) => l.trim()) || ""
    : "";
  const startedRel = relativeTime(run.startedAt || run.createdAt);
  const startedAbs = run.startedAt || run.createdAt;
  const workflowHref = slug ? deepLinks.workflow(slug) : deepLinks.workflows();
  const workflowLabel = run.capabilityName || slug || "Workflow";
  const canCancel = isActiveRun(run);
  // Pause is an edge from assigned/running only (a queued run has nothing to
  // checkpoint; the transition would 409).
  const canPause = statusKey === "assigned" || statusKey === "running";
  const canResume = statusKey === "paused" && run.pause?.resumable !== false;
  const promotion = runPromotionCandidate(run);

  return (
    <header className="run-banner" data-status={statusKey} data-failure={isFailure ? "1" : "0"}>
      <div className="run-banner-headline">
        <span className="run-banner-status"><StatusBadge value={run.status} label={runStatusLabel(run.status)} /></span>
        {durStr ? <span className="run-banner-duration" title="Total duration"><span className="muted" aria-hidden="true">⏱</span> {durStr}</span> : null}
        {startedRel ? <span className="run-banner-time muted" title={startedAbs || ""}>started {startedRel}</span> : null}
        {headline ? <span className="run-banner-error" title={diagnostics?.headline || ""}>{headline}</span> : null}
      </div>
      <h1 className="run-banner-title">{title}</h1>
      <p className="run-banner-subtitle muted">
        <button type="button" className="run-id-mono run-id-mono-copy" title={`${run.id} — click to copy`} aria-label={`Copy run id ${run.id}`} onClick={() => copyText(run.id, "Run id copied")}>
          {run.id}
        </button>
        {slug ? <a className="run-cap-link" href={workflowHref}>{workflowLabel}</a> : null}
      </p>
      <div className="run-banner-actions" role="group" aria-label="Run actions">
        {promotion.available ? (
          <button
            type="button"
            className="primary"
            title={`Merge ${promotion.sourceBranch} into ${promotion.targetBranch}, run gates, push, and clean up the branch/worktree`}
            onClick={async () => { await promoteRun(run.id); onChanged?.(); }}
          >
            <Icon name="branch" /> Merge to main
          </button>
        ) : null}
        {canResume ? (
          <button
            type="button"
            className="primary"
            title={run.pause?.resume?.smithersRunId
              ? `Resume from checkpoint ${run.pause.resume.smithersRunId}`
              : "Re-queue this run (no engine checkpoint was recorded, so it restarts from scratch)"}
            onClick={async () => { await resumeRun(run.id); onChanged?.(); }}
          >
            ▶ Resume run
          </button>
        ) : null}
        <button type="button" className="primary" title="Re-run with the same input (no editor)" onClick={() => rerunRun(run.id)}>Re-run same input</button>
        <details className="run-action-overflow">
          <summary className="button run-action-overflow-trigger" aria-haspopup="menu" aria-label="More run actions">More <span aria-hidden="true">▾</span></summary>
          <div className="run-action-overflow-menu" role="menu">
            <button type="button" role="menuitem" title="Open the input editor, then queue a re-run" onClick={() => editRerunRun(run)}>Edit input &amp; re-run…</button>
            <button type="button" role="menuitem" title="Copy this run's id" onClick={() => copyText(run.id, "Run id copied")}>Copy run id</button>
            <a className="button" role="menuitem" href={workflowHref} title="Open this run's workflow definition">Open workflow</a>
            {canPause ? (
              <button type="button" role="menuitem" title="Park this run as paused — it keeps its engine checkpoint, frees its runner slot, and resumes later" onClick={async () => { await pauseRun(run.id, "manual", "Paused from Web Hub"); onChanged?.(); }}>Pause run</button>
            ) : null}
            {canCancel ? (
              <button type="button" className="danger" role="menuitem" title="Stop this run now" onClick={async () => { await cancelRun(run.id, "Cancelled from Web Hub"); onChanged?.(); }}>Cancel run</button>
            ) : null}
          </div>
        </details>
      </div>
    </header>
  );
}

export function RunMetaStrip({ run }) {
  const durStr = formatDuration(runDurationMs(run));
  const items = [];
  const startedAt = run.startedAt || run.createdAt;
  if (startedAt) items.push(<li className="chip--time" key="s"><span className="muted">Started</span> <span title={startedAt}>{relativeTime(startedAt)}</span></li>);
  if (run.completedAt) items.push(<li className="chip--time" key="e"><span className="muted">Ended</span> <span title={run.completedAt}>{relativeTime(run.completedAt)}</span></li>);
  if (durStr) items.push(<li className="chip--time" key="d"><span className="muted">Duration</span> {durStr}</li>);
  const attempt = Number(run.attempt || 0);
  if (attempt > 0) items.push(<li key="a"><span className="muted">Attempt</span> {attempt}</li>);
  const trigger = run.originLabel || run.origin?.label || "";
  if (trigger) items.push(<li key="t"><span className="muted">Trigger</span> {trigger}</li>);
  const usage = runUsage(run);
  if (usage) {
    const byModel = Object.entries(usage.byModel)
      .map(([model, totals]) => `${model}: ${formatTokens(totals.totalTokens)} tokens${totals.costMicros ? ` · ${formatCostMicros(totals.costMicros)}` : ""}`)
      .join("\n");
    const usageTitle = `${usage.calls} metered model call${usage.calls === 1 ? "" : "s"}${byModel ? `\n${byModel}` : ""}`;
    items.push(
      <li key="u" title={usageTitle}>
        <span className="muted">Usage</span> {usage.tokensLabel} tok{usage.costLabel ? ` · ${usage.costLabel}` : ""}
      </li>
    );
  }
  // Budget renders as spent / limit (percent) — the server pairs the numbers
  // in run.budgetStatus so this never re-derives arithmetic. Falls back to the
  // bare ceiling for payloads without the computed status.
  const budgetStatus = run.budgetStatus && typeof run.budgetStatus === "object" ? run.budgetStatus : null;
  if (budgetStatus) {
    const parts = [];
    if (budgetStatus.maxTokens) {
      parts.push(`${formatTokens(budgetStatus.tokensUsed) || "0"} / ${formatTokens(budgetStatus.maxTokens)} tok (${budgetStatus.tokensPercentUsed}%)`);
    }
    if (budgetStatus.maxCostMicros) {
      parts.push(`${formatCostMicros(budgetStatus.costMicrosUsed) || "$0"} / ${formatCostMicros(budgetStatus.maxCostMicros)} (${budgetStatus.costPercentUsed}%)`);
    }
    items.push(
      <li key="b" data-near-limit={budgetStatus.nearLimit ? "true" : "false"} title="Hard spend ceiling — spent / limit (percent used)">
        <span className="muted">Budget</span> {parts.join(" · ")}
      </li>
    );
  } else if (run.budget && typeof run.budget === "object") {
    const parts = [];
    if (run.budget.maxTokens) parts.push(`${formatTokens(run.budget.maxTokens)} tok`);
    if (run.budget.maxCostMicros) parts.push(formatCostMicros(run.budget.maxCostMicros));
    if (parts.length) items.push(<li key="b" title="Hard spend ceiling for this run"><span className="muted">Budget</span> {parts.join(" · ")}</li>);
  }
  if (!items.length) return null;
  return <ul className="run-meta-strip" aria-label="Run metadata">{items}</ul>;
}

// Budget-stop callout: unmissable, plain-English explanation of why the run
// ended, shown only for budget_exceeded runs.
export function RunBudgetNotice({ run }) {
  if (!run || run.status !== "budget_exceeded") return null;
  const status = run.budgetStatus && typeof run.budgetStatus === "object" ? run.budgetStatus : null;
  const numbers = [];
  if (status?.maxTokens) numbers.push(`${formatTokens(status.tokensUsed) || "0"} of ${formatTokens(status.maxTokens)} budgeted tokens`);
  if (status?.maxCostMicros) numbers.push(`${formatCostMicros(status.costMicrosUsed) || "$0"} of the ${formatCostMicros(status.maxCostMicros)} cost ceiling`);
  return (
    <div className="run-budget-notice" role="status" aria-label="Budget stop">
      <strong>Stopped at budget.</strong>{" "}
      <span>{truncate(String(run.error || "This run reached its spend budget and was terminated before further model calls."), 240)}</span>
      {numbers.length ? <span className="muted"> — used {numbers.join(" and ")}. Raise the budget and re-run to finish the work.</span> : null}
    </div>
  );
}

// Pause callout: why the run is parked, what unblocks it, and the resume
// action. Shown only for paused runs; mirrors the RunBudgetNotice pattern.
// Reason labels live in runHelpers (shared with the runs-list chip and the
// attention strip).
export function RunPauseNotice({ run, onChanged }) {
  if (!run || run.status !== "paused") return null;
  const pause = run.pause && typeof run.pause === "object" ? run.pause : {};
  const reasonLabel = pauseReasonLabel(pause.reason);
  const actionLabel = pause.requiredAction?.label || "Resolve the interruption, then resume";
  const checkpoint = pause.resume?.smithersRunId || "";
  const resumable = pause.resumable !== false;
  return (
    <div className="run-pause-notice" role="status" aria-label="Run paused">
      <strong>{reasonLabel}.</strong>{" "}
      <span>{truncate(String(pause.message || "This run was interrupted by a recoverable condition and is parked, not failed."), 240)}</span>{" "}
      <span className="muted">
        {actionLabel}
        {checkpoint ? ` · resumes from checkpoint ${checkpoint} on the runner that holds it` : " · no engine checkpoint was recorded, so resuming restarts from scratch"}
      </span>
      {resumable ? (
        <button
          type="button"
          className="primary"
          title={checkpoint ? `Continue from checkpoint ${checkpoint}` : "Re-queue this run; it restarts from scratch"}
          onClick={async () => { await resumeRun(run.id); onChanged?.(); }}
        >▶ Resume run</button>
      ) : null}
      {resumable && checkpoint ? (
        <button
          type="button"
          className="button"
          title="Discard the recorded checkpoint and runner pin; re-run from scratch on any live runner (use when the checkpoint's runner is gone or the checkpoint is stale)"
          onClick={async () => { await resumeRun(run.id, { fromScratch: true }); onChanged?.(); }}
        >Restart from scratch</button>
      ) : null}
    </div>
  );
}

export function RunOutcomeSummary({ summary }) {
  if (!summary) return null;
  const files = Array.isArray(summary.files) ? summary.files : [];
  // Hover-tooltip the actual file list on the Changed-files chip when the
  // workflow reported specifics — operators used to see only "0" here even
  // when a commit touched real files, because the count came exclusively from
  // `commit.files`. The count now unions every workflow's file-key variants
  // (see collectChangedFiles); this exposes the underlying list for context.
  const filesTitle = files.length
    ? `${files.length} changed file${files.length === 1 ? "" : "s"}:\n${files.join("\n")}`
    : "No changed files reported by this run.";
  const churn = summary.churn && typeof summary.churn === "object" && !Array.isArray(summary.churn)
    ? summary.churn
    : null;
  const additions = churn ? Number(churn.additions) : null;
  const deletions = churn ? Number(churn.deletions) : null;
  const hasChurn = Number.isFinite(additions) && Number.isFinite(deletions) && (additions || deletions);
  const digest = typeof summary.digest === "string" ? summary.digest.trim() : "";
  const items = [
    ["Repo", summary.repo || "unresolved", null],
    ["Changed files", String(summary.changedFiles ?? 0), filesTitle],
    // GitHub-style green +additions / red −deletions when a diff was produced;
    // dash for runs (or old runs that pre-date the summary) with no churn.
    ["Code churn", hasChurn ? { churn: { additions, deletions } } : "—",
      hasChurn ? `${additions} line${additions === 1 ? "" : "s"} added · ${deletions} line${deletions === 1 ? "" : "s"} removed` : "No line-level churn was reported."],
    ["Work product", summary.workProduct || "none", null],
    ["Classification", summary.classification || "unknown", null]
  ];
  return (
    <>
      <section className="run-outcome-summary" aria-label="Run outcome summary">
        {items.map(([label, value, title]) => (
          <p key={label} {...(title ? { title } : {})}>
            <span className="muted">{label}</span>
            {value && typeof value === "object" && value.churn ? (
              <strong><CodeChurn churn={value.churn} /></strong>
            ) : (
              <strong>{value}</strong>
            )}
          </p>
        ))}
      </section>
      {digest ? (
        <p className="run-outcome-digest" aria-label="Run digest">{digest}</p>
      ) : null}
    </>
  );
}

// --- Diagnostics panel (ported from renderRunDiagnostics) -------------------
const LIVE_STATUSES = new Set(["queued", "assigned", "running", "pending"]);

export function RunDiagnostics({ diagnostics }) {
  if (!diagnostics) return null;
  const statusKey = diagnostics.status || "";
  const intro = statusKey === "waiting_approval"
    ? "This run is paused waiting for an approval decision."
    : statusKey === "paused"
      ? "This run is paused on a recoverable interruption — it is parked, not failed, and can be resumed."
      : statusKey === "budget_exceeded"
        ? "This run was stopped by its spend budget. Diagnostic details below."
        : statusKey === "failed" || statusKey === "error"
          ? "This run failed. Diagnostic details below."
          : "This run was cancelled. Diagnostic details below.";
  const isLive = LIVE_STATUSES.has(statusKey);
  const timeline = Array.isArray(diagnostics.timeline) ? diagnostics.timeline : [];
  const logs = Array.isArray(diagnostics.logExcerpts) ? diagnostics.logExcerpts : [];
  const arts = Array.isArray(diagnostics.artifacts) ? diagnostics.artifacts : [];
  const logsText = logs.map((e) => `[${e.createdAt}] ${e.type}: ${e.message}`).join("\n");

  return (
    <section className={`panel diagnostics-panel diagnostics-${statusKey}`} aria-label="Run diagnostics">
      <header className="diagnostics-head">
        <h2>Why this run {statusKey === "waiting_approval" || statusKey === "paused" ? "is paused" : statusKey === "failed" || statusKey === "error" ? "failed" : "was cancelled"}</h2>
        <StatusBadge value={statusKey} label={runStatusLabel(statusKey)} />
      </header>
      <p className="muted diagnostics-intro">{intro}</p>
      {diagnostics.headline ? <p className="diagnostics-headline">{diagnostics.headline}</p> : null}
      {(diagnostics.failedStep || diagnostics.failureType || diagnostics.failedAt || diagnostics.cancelledBy || diagnostics.approval) ? (
        <dl className="diagnostics-facts">
          {diagnostics.failedStep ? <><dt>Failed step</dt><dd>{diagnostics.failedStep}</dd></> : null}
          {diagnostics.failureType ? <><dt>Failure event</dt><dd><code>{diagnostics.failureType}</code></dd></> : null}
          {diagnostics.failedAt ? <><dt>When</dt><dd>{formatTimestamp(diagnostics.failedAt)}</dd></> : null}
          {diagnostics.cancelledBy ? <><dt>Cancelled by</dt><dd>{diagnostics.cancelledBy}</dd></> : null}
          {diagnostics.approval ? (
            <>
              <dt>Linked approval</dt>
              <dd>
                <a href={diagnostics.approval.deepLink}>{diagnostics.approval.title || diagnostics.approval.id}</a>{" "}
                <span className="muted">
                  {diagnostics.approval.status === "pending"
                    ? diagnostics.approval.statusLabel || "Pending decision"
                    : diagnostics.approval.resolutionSentence || diagnostics.approval.resolutionLabel || "Resolved"}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {diagnostics.approval?.status === "pending" && diagnostics.approval.ifIgnored ? (
        <p className="muted diagnostics-intro">{diagnostics.approval.ifIgnored}</p>
      ) : null}
      {diagnostics.approval?.comment ? (
        <div className="diagnostics-approval-quote">
          <h4>Approval comment</h4>
          <blockquote>{diagnostics.approval.comment}</blockquote>
          <p className="muted">{diagnostics.approval.resolvedBy || diagnostics.approval.requestedBy || "approval"}{diagnostics.approval.resolvedAt ? ` · ${formatTimestamp(diagnostics.approval.resolvedAt)}` : ""}</p>
        </div>
      ) : null}
      {diagnostics.reason && diagnostics.reason !== diagnostics.headline ? (
        <details className="diagnostics-reason" open>
          <summary>Reason</summary>
          <pre className="diagnostics-pre"><code>{diagnostics.reason}</code></pre>
          <button type="button" className="button copy-btn" title="Copy reason" onClick={() => copyText(diagnostics.reason, "Reason copied")}>Copy reason</button>
        </details>
      ) : null}
      {(timeline.length || isLive) ? (
        <div className="diagnostics-timeline">
          <h4>{isLive ? "Recent events" : "Events around the failure"}</h4>
          <ol className="diagnostics-event-list">
            {isLive ? <li className="diagnostics-live-indicator" aria-label="Run is streaming events"><span className="diagnostics-live-dot" aria-hidden="true" /><span>Live</span></li> : null}
            {timeline.map((event, i) => (
              <li key={i}>
                <time>{formatTimestamp(event.createdAt)}</time>
                <code className="diagnostics-event-type">{event.type}</code>
                <div className="diagnostics-event-msg-cell"><span className="diagnostics-event-msg">{event.message || ""}</span></div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {logs.length ? (
        <div className="diagnostics-logs">
          <div className="diagnostics-logs-head">
            <h4>Recent log excerpts</h4>
            <button type="button" className="button copy-btn" title="Copy these failure-window excerpts" onClick={() => copyText(logsText, "Excerpt copied")}>Copy excerpt</button>
          </div>
          <pre className="diagnostics-pre"><code>{logsText}</code></pre>
          <p className="muted">Token/secret-shaped strings are redacted in this excerpt.</p>
        </div>
      ) : null}
      {arts.length ? (
        <div className="diagnostics-artifacts">
          <h4>Diagnostic artifacts</h4>
          <ul className="artifact-list">
            {arts.map((a) => (
              <li key={a.id}>
                <a href={deepLinks.artifact(a)}>{artifactDisplayName(a)}</a>{" "}
                <a className="muted artifact-dl" href={`/api/artifacts/${a.id}/download`} target="_blank" rel="noreferrer">download</a>{" "}
                <span className="muted">{formatBytes(a.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// --- Inputs & outputs (ported from renderRunInputsOutputs) ------------------
function payloadSummary(value) {
  if (value == null) return "empty";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "empty object";
    return `${keys.length} key${keys.length === 1 ? "" : "s"}: ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}`;
  }
  if (typeof value === "string") return `${value.length} character${value.length === 1 ? "" : "s"}`;
  return typeof value;
}
function humanizePayloadKey(key) {
  return String(key || "").replace(/^__+/, "").replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().replace(/\b\w/g, (c) => c.toUpperCase()) || "Value";
}
function payloadValuePreview(value) {
  if (value == null) return "empty";
  if (typeof value === "string") return value.trim() ? truncate(value.trim(), 180) : "empty string";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "empty list";
    const first = value[0];
    const sample = first && typeof first === "object" ? payloadSummary(first) : payloadValuePreview(first);
    return `${value.length} item${value.length === 1 ? "" : "s"}${sample ? ` · first: ${sample}` : ""}`;
  }
  if (typeof value === "object") return payloadSummary(value);
  return String(value);
}
function payloadEntries(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.slice(0, 6).map((item, i) => [`Item ${i + 1}`, item]);
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const visible = entries.filter(([k]) => !String(k).startsWith("__"));
    return (visible.length ? visible : entries).slice(0, 8);
  }
  return [["Value", value]];
}
function payloadBytes(value) {
  try {
    const s = JSON.stringify(value ?? null);
    if (!s) return 0;
    return typeof Blob === "function" ? new Blob([s]).size : s.length;
  } catch { return 0; }
}

function PayloadBlock({ label, value }) {
  const entries = payloadEntries(value);
  return (
    <article className="run-io-card">
      <header className="run-io-card-head">
        <h3>{label}</h3>
        <span className="run-io-card-meta muted">{payloadSummary(value)} · {formatBytes(payloadBytes(value))}</span>
      </header>
      <div className="run-io-human">
        {entries.length ? (
          <dl className="run-io-summary-list">
            {entries.map(([key, item], i) => (
              <div className="run-io-summary-row" key={i}>
                <dt>{humanizePayloadKey(key)}</dt>
                <dd>{payloadValuePreview(item)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="run-io-empty muted">Nothing returned yet.</p>
        )}
      </div>
      <details className="run-io-raw">
        <summary>See raw JSON</summary>
        <JsonBlock value={value ?? null} />
      </details>
    </article>
  );
}

export function RunIO({ run }) {
  return (
    <div className="run-io-grid">
      <PayloadBlock label="Input" value={run?.input ?? null} />
      <PayloadBlock label="Output" value={run?.output ?? null} />
    </div>
  );
}
export { payloadBytes };

// --- Artifacts (ported from renderArtifactsCard; preview opens in a new tab) -
export function RunArtifacts({ artifacts = [] }) {
  if (!artifacts.length) return <p className="muted artifacts-empty">No artifacts produced by this run.</p>;
  return (
    <ul className="artifact-list rich">
      {artifacts.map((a) => {
        const previewable = !/^(application\/octet-stream|application\/zip)/.test(a.mimeType || "");
        return (
          <li className="artifact-row" id={`artifact-${a.id}`} key={a.id}>
            <span className="artifact-icon" aria-hidden="true">📄</span>
            <div className="artifact-row-main">
              <span className="artifact-row-name">{artifactDisplayName(a)}</span>
              <span className="muted artifact-row-meta">{formatBytes(a.sizeBytes)}{a.mimeType ? ` · ${a.mimeType}` : ""}</span>
            </div>
            <div className="artifact-row-actions">
              {previewable ? <a className="button" href={`/api/artifacts/${a.id}/download`} target="_blank" rel="noreferrer">Preview</a> : null}
              <a className="button" href={`/api/artifacts/${a.id}/download`} target="_blank" rel="noopener">Open ↗</a>
              <ShareButton hash={deepLinks.artifact(a)} label="Copy share link to this artifact in its run" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
