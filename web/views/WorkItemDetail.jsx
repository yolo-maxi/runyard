import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { api } from "../lib/api.js";
import { workflowsCollection } from "../lib/collections.js";
import { deepLinks, navigate } from "../lib/router.js";
import { relativeTime, formatTimestamp } from "../lib/format.js";
import { isActiveRun } from "../lib/runHelpers.js";
import { meIsAdmin } from "../lib/me.js";
import { toast } from "../lib/toast.js";
import { Breadcrumbs, OverflowMenu, StatusBadge, Toolbar } from "../components/ui.jsx";
import { WorkFlowStepper } from "../components/WorkFlowStepper.jsx";
import { WorkItemEditor } from "../components/WorkItemEditor.jsx";
import { WorkflowGraph } from "../components/WorkflowGraph.jsx";
import { WORK_ITEM_STATUSES } from "../lib/workItems.js";

// Work item (ticket) workbench: what are we trying to do, what runs/approvals/
// artifacts are attached, what happened, and what is next — plus the execution
// flow of the active/latest linked run. Layout is a main column (goal, runs,
// flow) with a properties + activity rail, like a proper inspector.

function LinkedRunRow({ run, onUnlink }) {
  return (
    <li className="work-run-row" data-linked-run={run.id}>
      <StatusBadge value={run.status} />
      <span className="work-run-main">
        <a href={run.deepLink || deepLinks.run(run.id)} className="work-run-title">
          {run.title || run.capabilityName || run.capabilitySlug || run.id}
        </a>
        <span className="work-run-sub">{run.capabilitySlug} · {relativeTime(run.createdAt)}</span>
      </span>
      <button className="btn-sm" data-unlink-run={run.id} onClick={() => onUnlink(run.id)}>Unlink</button>
    </li>
  );
}

// Launch a workflow run pre-linked to this ticket, or link an existing run id.
function RunAttach({ workItem, onChanged }) {
  const { data: workflows = [] } = useLiveQuery((q) => workflowsCollection);
  const [slug, setSlug] = useState("");
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false);

  async function launch() {
    if (!slug) return toast("Choose a workflow", "error");
    setBusy(true);
    try {
      const result = await api(`/api/workflows/${encodeURIComponent(slug)}/run`, {
        method: "POST",
        body: { input: { title: workItem.title }, workItemId: workItem.id }
      });
      toast("Run launched and linked", "ok");
      await onChanged();
      if (result?.run?.id) navigate(deepLinks.run(result.run.id));
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    const id = runId.trim();
    if (!id) return toast("Paste a run id", "error");
    try {
      await api(`/api/work-items/${workItem.id}/link-run`, { method: "POST", body: { runId: id } });
      toast("Run linked", "ok");
      setRunId("");
      await onChanged();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  return (
    <div className="work-run-attach">
      <div className="work-run-launch">
        <select id="work-launch-workflow" value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Workflow to launch">
          <option value="">Launch a workflow…</option>
          {workflows.map((wf) => (
            <option key={wf.slug} value={wf.slug}>{wf.name} ({wf.slug})</option>
          ))}
        </select>
        <button className="primary" id="work-launch-run" disabled={busy || !slug} onClick={launch}>Run</button>
      </div>
      <div className="work-run-link">
        <input
          id="work-link-run-id"
          placeholder="run_… (link an existing run)"
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
        />
        <button id="work-link-run" onClick={link}>Link run</button>
      </div>
    </div>
  );
}

function FlowSection({ runs, focus }) {
  const active = runs.filter(isActiveRun);
  const defaultRun = (active[0] || runs[0]) ?? null;
  const [picked, setPicked] = useState("");
  const runId = picked || defaultRun?.id || "";
  const run = runs.find((r) => r.id === runId) || defaultRun;
  const sectionRef = useRef(null);

  useEffect(() => {
    if (focus === "flow" && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focus]);

  const { data: flow, error } = useQuery({
    queryKey: ["run-flow", runId],
    queryFn: () => api(`/api/runs/${encodeURIComponent(runId)}/flow`),
    enabled: Boolean(runId),
    refetchInterval: run && isActiveRun(run) ? 5_000 : false
  });

  const graph = useMemo(() => {
    if (!flow || (flow.nodes || []).length <= 2 || !(flow.edges || []).length) return null;
    return { name: flow.name, nodes: flow.nodes, edges: flow.edges, sideNodes: [] };
  }, [flow]);

  return (
    <section className="panel work-flow-panel" id="flow" ref={sectionRef}>
      <header className="work-panel-head">
        <h3>Execution flow</h3>
        {runs.length > 1 ? (
          <select
            id="work-flow-run-picker"
            value={runId}
            onChange={(e) => setPicked(e.target.value)}
            aria-label="Run to visualize"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>{r.id} · {r.status}</option>
            ))}
          </select>
        ) : null}
      </header>
      {!runId ? (
        <p className="work-quiet-empty">No linked runs yet — launch or link one to see its flow here.</p>
      ) : null}
      {error ? <p className="muted">{error.message}</p> : null}
      {graph ? (
        <div className="graph-canvas work-flow-graph">
          <WorkflowGraph graph={graph} />
        </div>
      ) : null}
      {flow ? <WorkFlowStepper flow={flow} /> : null}
    </section>
  );
}

function PropRow({ label, children }) {
  return (
    <div className="work-prop">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function WorkItemDetail({ id, focus = "", me = null }) {
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();

  const { data, error } = useQuery({
    queryKey: ["work-item", id],
    queryFn: () => api(`/api/work-items/${id}`),
    refetchInterval: (query) =>
      (query.state.data?.runs || []).some(isActiveRun) ? 10_000 : 30_000
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["work-item", id] });
    await queryClient.invalidateQueries({ queryKey: ["work-items"] });
  };

  if (error) {
    return (
      <>
        <Breadcrumbs items={[{ label: "Work", href: deepLinks.work() }, { label: "Work item", current: true }]} />
        <Toolbar title="Work item" />
        <section className="panel"><p className="muted">{error.message}</p></section>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <Breadcrumbs items={[{ label: "Work", href: deepLinks.work() }, { label: "Work item", current: true }]} />
        <Toolbar title="Work item" />
        <section className="panel"><p className="muted">Loading…</p></section>
      </>
    );
  }

  const item = data.workItem;
  const runs = data.runs || [];
  const approvals = data.approvals || [];
  const artifacts = data.artifacts || [];
  const events = (data.events || []).slice(0, 20);

  async function moveTo(status) {
    if (status === item.status) return;
    try {
      await api(`/api/work-items/${id}`, { method: "PATCH", body: { status } });
      toast(`Moved to ${status}`, "ok");
      await invalidate();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function unlink(runId) {
    try {
      await api(`/api/work-items/${id}/unlink-run`, { method: "POST", body: { runId } });
      toast("Run unlinked", "ok");
      await invalidate();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function remove() {
    if (!window.confirm("Delete this work item? Linked runs survive unlinked. Prefer archiving to keep history.")) return;
    try {
      await api(`/api/work-items/${id}`, { method: "DELETE" });
      toast("Work item deleted", "ok");
      await queryClient.invalidateQueries({ queryKey: ["work-items"] });
      navigate(deepLinks.work());
    } catch (err) {
      toast(err.message, "error");
    }
  }

  return (
    <>
      <Breadcrumbs items={[{ label: "Work", href: deepLinks.work() }, { label: item.title, current: true }]} />
      <Toolbar title={item.title} shareHash={deepLinks.workItem(item.id)}>
        <select
          id="work-item-status"
          className="work-status-select"
          value={item.status}
          onChange={(e) => moveTo(e.target.value)}
          aria-label="Move this work item"
        >
          {WORK_ITEM_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button id="edit-work-item" onClick={() => setEditing(true)}>Edit</button>
        <OverflowMenu
          items={[
            meIsAdmin(me) ? { label: "Delete work item", danger: true, onSelect: remove } : null
          ]}
        />
      </Toolbar>

      <div className="work-detail">
        <div className="work-detail-main">
          <section className="panel work-goal">
            <header className="work-panel-head">
              <h3>Goal</h3>
              <span className="work-detail-chips">
                <span className={`chip work-type-${item.type}`}>{item.type}</span>
                <span className={`chip work-priority-${item.priority}`}>{item.priority}</span>
              </span>
            </header>
            {item.description ? <p className="work-description">{item.description}</p> : <p className="muted">No description yet.</p>}
            {item.nextAction ? (
              <p className="work-next-action"><strong>Next</strong> {item.nextAction}</p>
            ) : null}
            {item.blockedReason ? (
              <p className="work-blocked-reason"><strong>Blocked</strong> {item.blockedReason}</p>
            ) : null}
            {item.acceptanceCriteria ? (
              <>
                <h4>Acceptance criteria</h4>
                <p className="work-acceptance">{item.acceptanceCriteria}</p>
              </>
            ) : null}
          </section>

          <section className="panel work-runs-panel">
            <header className="work-panel-head">
              <h3>Linked runs</h3>
              {runs.length ? <span className="badge">{runs.length}</span> : null}
            </header>
            {runs.length ? (
              <ul className="work-run-list">
                {runs.map((run) => <LinkedRunRow key={run.id} run={run} onUnlink={unlink} />)}
              </ul>
            ) : (
              <p className="work-quiet-empty">No runs attached to this ticket yet — launch one below.</p>
            )}
            <div className="work-linked-block">
              <h4>{runs.length ? "Continue with a workflow" : "Start with a workflow"}</h4>
              <p className="work-attach-hint">
                Launched runs are linked to this ticket and move it across the board as they progress.
              </p>
              <RunAttach workItem={item} onChanged={invalidate} />
            </div>
            {approvals.length ? (
              <div className="work-linked-block">
                <h4>Approvals</h4>
                <ul className="work-approval-list">
                  {approvals.map((approval) => (
                    <li key={approval.id}>
                      <a href={deepLinks.approval(approval.id)}>{approval.title}</a>
                      <StatusBadge value={approval.resolution || approval.status} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {artifacts.length ? (
              <div className="work-linked-block">
                <h4>Artifacts</h4>
                <ul className="work-artifact-list">
                  {artifacts.map((artifact) => (
                    <li key={artifact.id}>
                      <a href={deepLinks.artifact(artifact)}>{artifact.name}</a>
                      <span className="muted">{artifact.kind} · {relativeTime(artifact.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <FlowSection runs={runs} focus={focus} />
        </div>

        <aside className="work-detail-rail">
          <section className="panel work-props">
            <h3>Properties</h3>
            <dl className="work-props-list">
              <PropRow label="Status"><StatusBadge value={item.status} label={item.status} /></PropRow>
              <PropRow label="Type"><span className={`chip work-type-${item.type}`}>{item.type}</span></PropRow>
              <PropRow label="Priority"><span className={`chip work-priority-${item.priority}`}>{item.priority}</span></PropRow>
              {item.project ? <PropRow label="Project">{item.project}</PropRow> : null}
              {item.owner ? <PropRow label="Owner">@{item.owner}</PropRow> : null}
              {item.requester ? <PropRow label="Requester">{item.requester}</PropRow> : null}
              {item.dueAt ? (
                <PropRow label="Due"><span title={formatTimestamp(item.dueAt)}>{relativeTime(item.dueAt)}</span></PropRow>
              ) : null}
              <PropRow label="Updated"><span title={formatTimestamp(item.updatedAt)}>{relativeTime(item.updatedAt)}</span></PropRow>
              <PropRow label="Created"><span title={formatTimestamp(item.createdAt)}>{relativeTime(item.createdAt)}</span></PropRow>
              <PropRow label="Id"><code className="work-prop-id">{item.id}</code></PropRow>
            </dl>
          </section>
          <section className="panel work-activity">
            <h3>Activity</h3>
            {events.length ? (
              <ul className="work-activity-list">
                {events.map((event) => (
                  <li key={event.id}>
                    <span className="work-activity-dot" aria-hidden="true" />
                    <span className="work-activity-body">
                      <span className="work-activity-type">{event.type.replace(/^work_item\./, "").replace(/_/g, " ")}</span>{" "}
                      {event.message}
                      <span className="work-activity-time">{relativeTime(event.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="work-quiet-empty">No activity yet.</p>
            )}
          </section>
        </aside>
      </div>

      {editing ? <WorkItemEditor id={item.id} onClose={() => setEditing(false)} /> : null}
    </>
  );
}
