import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks, navigate } from "../lib/router.js";
import { copyText } from "../lib/clipboard.js";
import { useMe, meIsAdmin } from "../lib/me.js";
import { formatBytes } from "../lib/runHelpers.js";
import { refreshCollection } from "../lib/collections.js";
import { toast } from "../lib/toast.js";
import { Toolbar, Breadcrumbs, ShareButton, JsonBlock } from "../components/ui.jsx";
import { Pills, WorkflowRunsList, Empty, CopyRow } from "../components/WorkflowParts.jsx";
import { CodeBlock } from "../components/CodeBlock.jsx";
import { WorkflowGraph } from "../components/WorkflowGraph.jsx";
import { RunForm } from "../components/RunForm.jsx";
import { WorkflowEditor } from "../components/WorkflowEditor.jsx";

// Tabs for the workflow detail page. `aliases` lets legacy/short sub-paths
// resolve to the canonical tab (e.g. "" / "edit" → overview, "run" → runs).
// Ported 1:1 from the legacy WORKFLOW_TABS constant; the "Visual graph" label
// is preserved exactly.
const WORKFLOW_TABS = [
  { key: "overview", label: "Overview", aliases: ["", "edit"] },
  { key: "graph", label: "Visual graph", aliases: ["visual", "diagram"] },
  { key: "code", label: "Code", aliases: ["source"] },
  { key: "runs", label: "Runs", aliases: ["run"] }
];

function resolveWorkflowTab(sub) {
  const value = String(sub || "").toLowerCase();
  for (const tab of WORKFLOW_TABS) {
    if (tab.key === value) return tab.key;
    if (tab.aliases.includes(value)) return tab.key;
  }
  return "overview";
}

// --- Visual graph tab -------------------------------------------------------
// Loads /api/workflows/:id/source → `.graph` and mounts ReactFlow. A
// "Fit view" button bumps a signal the canvas reacts to.
function GraphTab({ slug, cap }) {
  const [fitSignal, setFitSignal] = useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: ["workflow-source", slug],
    queryFn: () => api(`/api/workflows/${encodeURIComponent(slug)}/source`)
  });

  const graph = useMemo(() => {
    if (data?.graph) return data.graph;
    // Client fallback graph derived from the workflow, mirroring
    // deriveClientGraphFallback().
    return {
      name: cap?.name || cap?.slug || "Workflow",
      nodes: [
        { id: "workflow", kind: "entry", label: cap?.name || cap?.slug || "Workflow" },
        { id: "execute", kind: "task", label: cap?.workflow?.entry || cap?.workflow?.name || "execute" }
      ],
      edges: [{ id: "e-workflow-execute", source: "workflow", target: "execute", kind: "sequence" }],
      sideNodes: []
    };
  }, [data, cap]);

  return (
    <section className="workflow-tab-body workflow-graph-tab">
      <div className="panel workflow-graph-panel">
        <header className="workflow-graph-header">
          <div>
            <h3>Visual graph</h3>
            <p className="muted">Smithers source is the source of truth. The canvas renders the workflow JSX into nodes, handles, and edges — pan and zoom with ReactFlow controls.</p>
          </div>
          <div className="workflow-graph-actions">
            <button type="button" id="wf-graph-fit" className="button" onClick={() => setFitSignal((n) => n + 1)}>Fit view</button>
            <a className="button" href={`#workflows/${slug}/code`}>Read source</a>
          </div>
        </header>
        <div className="workflow-graph-host workflow-graph-mounted" id="wf-graph-host">
          {error ? (
            <p className="notice">Could not load workflow graph: {error.message}</p>
          ) : isLoading ? (
            <div className="workflow-graph-loading muted">Loading ReactFlow…</div>
          ) : (
            <WorkflowGraph graph={graph} fitSignal={fitSignal} />
          )}
        </div>
      </div>
    </section>
  );
}

// --- Code tab (highlight.js viewer) -----------------------------------------
// Loads /api/workflows/:id/source and renders syntax-highlighted code, with
// Code / Agents / workflowGraph sub-tabs when those sections are present.
function CodeTab({ slug, cap }) {
  const [section, setSection] = useState("code");
  const { data, isLoading, error } = useQuery({
    queryKey: ["workflow-source", slug],
    queryFn: () => api(`/api/workflows/${encodeURIComponent(slug)}/source`)
  });

  const payload = data || {};
  const sections = payload.sections || {};
  const sectionDefs = useMemo(() => ([
    { key: "code", label: "Code", body: payload.code || "" },
    { key: "agents", label: "Agents", body: sections.agents?.text || "" },
    { key: "workflowGraph", label: "workflowGraph", body: sections.workflowGraph?.text || "" }
  ].filter((entry) => entry.body && entry.body.trim().length)), [payload, sections]);

  // Keep the active section valid as data loads.
  useEffect(() => {
    if (sectionDefs.length && !sectionDefs.some((d) => d.key === section)) {
      setSection(sectionDefs[0].key);
    }
  }, [sectionDefs, section]);

  const language = payload.language || "plaintext";
  const def = sectionDefs.find((d) => d.key === section) || sectionDefs[0];
  const pathLabel = payload.available
    ? `${payload.path} · ${String(payload.language || "").toUpperCase()} · ${formatBytes(payload.sizeBytes)}`
    : "Loading source…";

  return (
    <section className="workflow-tab-body workflow-code-tab">
      <div className="panel workflow-code-panel">
        <header className="workflow-code-header">
          <div>
            <h3>Code</h3>
            <p className="muted" id="wf-code-path">{isLoading ? "Loading source…" : pathLabel}</p>
          </div>
          <div className="workflow-code-actions">
            <nav className="tabs subtabs" id="wf-code-subtabs" aria-label="Source sections">
              {sectionDefs.map((entry, index) => (
                <button
                  key={entry.key}
                  type="button"
                  className={`tab ${entry.key === (def?.key ?? (index === 0 ? entry.key : "")) ? "active" : ""}`}
                  onClick={() => setSection(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
            <button
              type="button"
              id="wf-code-copy"
              className="button"
              disabled={!payload.available}
              onClick={() => copyText(payload.code || "", "Copied")}
            >
              Copy source
            </button>
          </div>
        </header>
        <div className="workflow-code-host" id="wf-code-host">
          {error ? (
            <p className="notice">Could not load workflow source: {error.message}</p>
          ) : isLoading ? (
            <p className="muted">Fetching the workflow source…</p>
          ) : !payload.available ? (
            <>
              <p className="muted">{payload.message || "No source stored for this workflow yet. Publish source through the API or MCP to view it here."}</p>
              <p className="muted">Registered entry: <code>{cap?.workflow?.entry || "—"}</code></p>
            </>
          ) : def ? (
            <CodeBlock code={def.body} language={language} />
          ) : (
            <p className="muted">No code to display.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function OverviewTab({ slug, cap, runs }) {
  const skills = cap.requiredSkills || [];
  const agents = cap.requiredAgents || [];
  const tags = cap.requiredRunnerTags || [];
  const workflow = cap.workflow || {};
  const approval = cap.approvalPolicy || {};
  const entryLabel = workflow.entry || workflow.name || (workflow.type ? `${workflow.type}` : "");
  const absLink = deepLinks.abs(deepLinks.workflow(slug));

  return (
    <section className="split workflow-tab-body">
      <div className="panel" id="panel-wf-detail">
        {agents.length ? <><h3>Required agents</h3><Pills items={agents} link={(s) => deepLinks.agent(s)} /></> : null}
        {skills.length ? <><h3>Required skills</h3><Pills items={skills} link={(s) => deepLinks.skill(s)} /></> : null}
        {tags.length ? <><h3>Runner tags</h3><Pills items={tags} kind="pill tag" /></> : null}
        <h3>Approval policy</h3>
        {approval.required ? (
          <p className="notice">This workflow can ask for approval at checkpoints while it runs.{approval.reason ? ` ${approval.reason}` : ""}</p>
        ) : (
          <p className="muted">No approval required — runs start as soon as a matching runner picks them up.</p>
        )}
        <h3>Workflow entry</h3>
        {entryLabel ? (
          <p><span className="kbd">{entryLabel}</span>{workflow.engine ? <span className="muted"> · engine {workflow.engine}</span> : null}</p>
        ) : (
          <p className="muted">No explicit entry registered.</p>
        )}
        <p className="muted">Open the <a href={`#workflows/${slug}/graph`}>Visual graph</a> tab to see the ReactFlow diagram, or <a href={`#workflows/${slug}/code`}>Code</a> to read the source.</p>
        <details className="advanced">
          <summary>Workflow contract (JSON)</summary>
          <JsonBlock value={{ inputSchema: cap.inputSchema || {}, outputSchema: cap.outputSchema || {}, workflow, requiredSkills: skills, requiredAgents: agents, requiredRunnerTags: tags, approvalPolicy: approval }} />
        </details>
      </div>
      <div className="panel" id="panel-wf-side">
        <h3>Deep link</h3>
        <CopyRow value={absLink} />
        <h3>Latest runs <ShareButton hash={deepLinks.workflowRuns(slug)} label="Copy share link to this workflow's runs" /></h3>
        {runs.length ? <WorkflowRunsList runs={runs.slice(0, 8)} /> : <p className="muted">No runs yet.</p>}
        {runs.length > 8 ? <p className="muted"><a href={`#workflows/${slug}/runs`}>See all {runs.length}</a></p> : null}
      </div>
    </section>
  );
}

function RunsTab({ slug, cap, runs }) {
  return (
    <section className="workflow-tab-body workflow-runs-tab">
      <div className="panel">
        <header className="workflow-runs-header">
          <div>
            <h3>Recent runs <ShareButton hash={deepLinks.workflowRuns(slug)} label="Copy share link to this workflow's runs" /></h3>
            <p className="muted">
              {runs.length ? <>Last {Math.min(runs.length, 20)} runs of <strong>{cap.name || slug}</strong>.</> : "No runs yet."}
            </p>
          </div>
          <button id="wf-run-2" className="primary" onClick={() => navigate(deepLinks.workflowRun(slug))}>Run this workflow</button>
        </header>
        {runs.length ? <WorkflowRunsList runs={runs.slice(0, 20)} /> : <Empty message="No runs yet." hint="Trigger a run to see the timeline, artifacts, and outputs here." />}
      </div>
    </section>
  );
}

// Rich detail view for one workflow with deep-linkable tabs:
//   Overview · Visual graph · Code · Runs
// `sub` selects the tab and the run-form / editor overlays ("run" / "edit").
export function WorkflowDetail({ slug, sub = "" }) {
  const { data: me } = useMe();
  // Workflow editing is admin-only server-side; hide the levers that 403.
  const canEdit = meIsAdmin(me);
  const capQuery = useQuery({
    queryKey: ["workflow", slug],
    queryFn: () => api(`/api/workflows/${slug}`)
  });
  const runsQuery = useQuery({
    queryKey: ["runs", "for-workflow", slug],
    queryFn: async () => {
      try { return (await api(`/api/runs?capability=${encodeURIComponent(slug)}&limit=20`)).runs ?? []; } catch { return []; }
    },
    refetchInterval: 4000
  });

  const activeTab = resolveWorkflowTab(sub);

  if (capQuery.error) {
    return (
      <>
        <Breadcrumbs items={[
          { label: "Workflows", href: deepLinks.workflows() },
          { label: slug, href: deepLinks.workflow(slug), current: true }
        ]} />
        <Toolbar title="Workflow" shareHash={deepLinks.workflow(slug)} />
        <section className="panel">
          <p className="muted">{capQuery.error.message}</p>
          <p><a href={deepLinks.workflows()}>Back to workflows</a></p>
        </section>
      </>
    );
  }
  if (capQuery.isLoading || !capQuery.data) {
    return <section className="panel"><p className="muted">Loading workflow…</p></section>;
  }

  const cap = capQuery.data.workflow;
  const runs = runsQuery.data ?? [];
  const approval = cap.approvalPolicy || {};
  const deleteWorkflow = async () => {
    if (!confirm(`Delete workflow "${cap.name || slug}"? Historical runs stay available, but the workflow will disappear from the active catalog.`)) return;
    try {
      await api(`/api/workflows/${encodeURIComponent(slug)}`, { method: "DELETE" });
      await refreshCollection("workflows");
      toast("Workflow deleted", "ok");
      navigate(deepLinks.workflows());
    } catch (error) {
      toast(error.message || "Could not delete workflow", "error");
    }
  };

  const tabsHtml = WORKFLOW_TABS.map((tab) => (
    <a
      key={tab.key}
      className={`tab ${tab.key === activeTab ? "active" : ""}`}
      data-wf-tab={tab.key}
      href={`#workflows/${encodeURIComponent(slug)}/${tab.key === "overview" ? "" : tab.key}`}
      onClick={(event) => {
        event.preventDefault();
        navigate(`#workflows/${slug}${tab.key === "overview" ? "" : `/${tab.key}`}`);
      }}
    >
      {tab.label}
    </a>
  ));

  return (
    <>
      <Breadcrumbs items={[
        { label: "Workflows", href: deepLinks.workflows() },
        { label: cap.name || slug, href: deepLinks.workflow(slug), current: true }
      ]} />
      <Toolbar title={cap.name} shareHash={deepLinks.workflow(slug)}>
        <button id="wf-run" className="primary" onClick={() => navigate(deepLinks.workflowRun(slug))}>Run this workflow</button>
        {canEdit ? <button id="wf-edit" onClick={() => navigate(deepLinks.workflowEdit(slug))}>Edit</button> : null}
        {canEdit ? <button id="wf-delete" className="danger" onClick={deleteWorkflow}>Delete</button> : null}
        <a className="button" href={deepLinks.workflows()}>All workflows</a>
      </Toolbar>
      <p className="muted workflow-detail-desc">{cap.description || "No description."}</p>
      <p className="workflow-meta-row muted">
        <span>{cap.category || "General"}</span>
        <span>·</span>
        <span>v{cap.version}</span>
        <span>·</span>
        <span>{cap.enabled ? "enabled" : "disabled"}</span>
        {approval.required ? <><span>·</span><span className="status waiting_approval">has approval checkpoints</span></> : null}
      </p>
      <nav className="tabs workflow-tabs" aria-label="Workflow sections">{tabsHtml}</nav>
      <div id="workflow-tab-body">
        {activeTab === "overview" ? <OverviewTab slug={slug} cap={cap} runs={runs} /> : null}
        {activeTab === "graph" ? <GraphTab slug={slug} cap={cap} /> : null}
        {activeTab === "code" ? <CodeTab slug={slug} cap={cap} /> : null}
        {activeTab === "runs" ? <RunsTab slug={slug} cap={cap} runs={runs} /> : null}
      </div>

      {sub === "run" ? (
        <RunForm cap={cap} slug={slug} />
      ) : sub === "edit" && canEdit ? (
        <WorkflowEditor slug={slug} />
      ) : (
        <section id="editor" className="panel hidden" />
      )}
    </>
  );
}
