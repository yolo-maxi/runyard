import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { isTerminalRun } from "../lib/collections.js";
import {
  runTitle, runDescription, runProject, runBranch, runExecutionLabel, isActiveRun, formatBytes
} from "../lib/runHelpers.js";
import { Breadcrumbs, Icon, ShareButton } from "../components/ui.jsx";
import { RunBanner, RunMetaStrip, RunDiagnostics, RunIO, RunArtifacts, payloadBytes } from "../components/RunDetailParts.jsx";
import { RunLog } from "../components/RunLog.jsx";
import { LiveConsole } from "../components/LiveConsole.jsx";

const SUCCESS = new Set(["succeeded", "recovered", "approved"]);
const FAILURE = new Set(["failed", "error", "cancelled", "rejected"]);

function sectionDefaultOpen(name, status) {
  if (name === "io") return true;
  if (FAILURE.has(status)) return name === "log" || name === "diagnostics";
  if (SUCCESS.has(status)) return name === "artifacts";
  // Active / queued / unknown: lead with the live console so the operator sees
  // the stream move; keep the static log open too.
  return name === "console" || name === "log";
}

// Collapsible run-detail section whose open state persists per run/section
// (sessionStorage), managed in React so the polling refetch can't snap it.
function RunSection({ runId, name, status, title, meta, actions, children }) {
  const key = `runDetail.section.${runId}.${name}`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = sessionStorage.getItem(key);
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch { /* ignore */ }
    return sectionDefaultOpen(name, status);
  });
  return (
    <details
      className="panel run-section"
      data-run-section={name}
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        try { sessionStorage.setItem(key, next ? "1" : "0"); } catch { /* ignore */ }
      }}
    >
      <summary className="run-section-summary">
        <span className="run-section-title">{title}</span>
        {meta != null ? <span className="run-section-meta muted">{meta}</span> : null}
        {actions ? <span className="run-section-actions">{actions}</span> : null}
      </summary>
      <div className="run-section-body">{children}</div>
    </details>
  );
}

export function RunDetail({ runId, focus = "" }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api(`/api/runs/${encodeURIComponent(runId)}`),
    // Live while the run can still emit; poll stops once terminal (the live
    // console SSE, added next, supersedes this for the event stream).
    refetchInterval: (q) => (q.state.data?.run && !isTerminalRun(q.state.data.run) ? 4000 : false),
    placeholderData: (prev) => prev
  });
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ["run", runId] }), [queryClient, runId]);

  if (isLoading && !data) return <section className="panel"><p className="muted">Loading run…</p></section>;
  if (error) return <section className="panel"><h2>Run not found</h2><p className="muted">{error.message}</p></section>;

  const run = data.run;
  const diagnostics = data.diagnostics || null;
  const slug = run.capabilitySlug || "";
  const title = runTitle(run);
  const description = runDescription(run);
  const project = runProject(run);
  const branch = runBranch(run);
  const origin = run.originLabel || run.origin?.label || "unknown origin";
  const execution = runExecutionLabel(run);
  const statusKey = String(run.status || "").toLowerCase();
  const artifacts = data.artifacts || [];
  const ioBytes = payloadBytes({ input: run.input ?? null, output: run.output ?? null });
  const active = isActiveRun(run);

  const chips = [];
  if (project) chips.push(<span className="chip chip-project" title={`Project: ${project}`} key="p"><Icon name="project" /> {project}</span>);
  if (branch) chips.push(<span className="chip chip-branch" title={`Branch: ${branch}`} key="b"><Icon name="branch" /> {branch}</span>);
  if (run.workflowVersion) chips.push(<span className="chip chip-version chip--id" title={`Workflow version ${run.workflowVersion}`} key="v">workflow v{run.workflowVersion}</span>);
  if (execution) chips.push(<span className="chip chip-runner" title={`Execution mode: ${execution}`} key="e">execution {execution}</span>);
  if (run.runnerId) chips.push(<span className="chip chip-runner chip--id" title={`Runner: ${run.runnerId}`} key="r"><Icon name="runner" /> {run.runnerId}</span>);

  return (
    <>
      <Breadcrumbs items={[
        { label: "Runs", href: deepLinks.runs() },
        { label: run.capabilityName || slug || "Workflow", href: slug ? deepLinks.workflow(slug) : deepLinks.workflows() },
        { label: run.id, href: deepLinks.run(run.id), title: `Run ${run.id}`, current: true }
      ]} />
      <RunBanner run={run} diagnostics={diagnostics} title={title} slug={slug} onChanged={refresh} />
      {chips.length ? (
        <div className="run-detail-meta-core">
          <RunMetaStrip run={run} />
          <details className="run-detail-meta" data-run-section="meta" open>
            <summary className="run-detail-meta-summary" aria-label="Run identifiers and fingerprint">
              <span className="run-detail-meta-toggle">Project, branch, runner &amp; version</span>
            </summary>
            <div className="run-detail-meta-body"><p className="run-detail-chips">{chips}</p></div>
          </details>
        </div>
      ) : <RunMetaStrip run={run} />}
      {run.status === "queued" ? (
        <p className="run-queue-banner" title="This run is queued — a runner with matching tags will pick it up next.">
          <span className="run-queue-icon" aria-hidden="true">⏳</span>
          <span className="run-queue-text">In queue</span>
          <span className="run-queue-detail muted">{run.queue?.position ? `#${run.queue.position}${run.queue.total ? ` of ${run.queue.total}` : ""} · ` : ""}waiting for a runner slot</span>
        </p>
      ) : null}
      {focus === "logs" ? <p className="muted">Linked directly to this run's log.</p> : null}
      {focus === "artifacts" ? <p className="muted">Linked directly to this run's artifacts.</p> : null}
      <RunDiagnostics diagnostics={diagnostics} />

      {active ? (
        <RunSection
          runId={run.id} name="console" status={statusKey} title="Live console"
          meta="streaming"
        >
          <LiveConsole runId={run.id} live />
        </RunSection>
      ) : null}

      <RunSection runId={run.id} name="io" status={statusKey} title="Inputs & outputs" meta={`${ioBytes ? formatBytes(ioBytes) : "empty"} total`}>
        <RunIO run={run} />
      </RunSection>

      <RunSection
        runId={run.id} name="log" status={statusKey} title="Run log"
        meta={run.currentStep || "—"}
        actions={<ShareButton hash={deepLinks.runLogs(run.id)} label="Copy share link to this run's log" />}
      >
        <RunLog events={data.events || []} summary={data.logSummary || null} />
      </RunSection>

      <RunSection
        runId={run.id} name="artifacts" status={statusKey} title="Artifacts"
        meta={`${artifacts.length} item${artifacts.length === 1 ? "" : "s"}`}
        actions={<ShareButton hash={deepLinks.runArtifacts(run.id)} label="Copy share link to this run's artifacts" />}
      >
        <RunArtifacts artifacts={artifacts} />
      </RunSection>

      {!active ? (
        <RunSection
          runId={run.id} name="console" status={statusKey} title="Console history"
          meta="captured stream"
        >
          <LiveConsole runId={run.id} live={false} />
        </RunSection>
      ) : null}

      <RunSection runId={run.id} name="context" status={statusKey} title="Run context" meta={origin}>
        {description ? <p className="run-detail-desc">{description}</p> : null}
        <p className="run-origin-detail"><strong>Origin</strong> {origin}</p>
      </RunSection>
    </>
  );
}
