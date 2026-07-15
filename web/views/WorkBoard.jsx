import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { Badge, Toolbar } from "../components/ui.jsx";
import { WorkCard } from "../components/WorkCard.jsx";
import { WorkItemEditor } from "../components/WorkItemEditor.jsx";
import { ARCHIVED_LANE, BOARD_LANES, isOperatorAttention, workItemAction } from "../lib/workItems.js";

// The Work board: work items (tickets) as kanban lanes. This is the
// company-level "what is being shipped" surface — workflows are recipes,
// runs are attempts, these cards are the durable work.

export function WorkBoard() {
  const [editing, setEditing] = useState(null); // null=closed, ""=new, id=edit
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [project, setProject] = useState("");
  const queryClient = useQueryClient();

  const { data, error } = useQuery({
    queryKey: ["work-items", { includeArchived: showArchived }],
    queryFn: () => api(`/api/work-items${showArchived ? "?includeArchived=true" : ""}`),
    refetchInterval: 15_000
  });

  const items = useMemo(() => {
    const all = data?.workItems || [];
    const q = filter.trim().toLowerCase();
    return all.filter((item) => {
      if (project && item.project !== project) return false;
      if (!q) return true;
      return [item.title, item.description, item.project, item.owner, item.id]
        .some((field) => String(field || "").toLowerCase().includes(q));
    });
  }, [data, filter, project]);

  const projects = useMemo(
    () => {
      const seen = new Map();
      for (const raw of (data?.workItems || []).map((item) => item.project).filter(Boolean)) {
        const key = String(raw).trim().toLowerCase();
        if (!seen.has(key)) seen.set(key, String(raw).trim());
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b));
    },
    [data]
  );

  const operatorItems = useMemo(() => {
    const order = { urgent: 0, blocked: 1, waiting: 2, review: 3, intake: 4 };
    return items
      .filter((item) => item.status !== "archived" && isOperatorAttention(item))
      .sort((a, b) => {
        const aScore = a.priority === "urgent" ? order.urgent : (order[a.status] ?? 8);
        const bScore = b.priority === "urgent" ? order.urgent : (order[b.status] ?? 8);
        if (aScore !== bScore) return aScore - bScore;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      })
      .slice(0, 6);
  }, [items]);

  const boardTotals = useMemo(() => {
    const active = items.filter((item) => item.status !== "archived");
    return {
      active: active.length,
      needsDecision: active.filter((item) => ["waiting", "blocked"].includes(item.status) || Number(item.runs?.attention || 0) > 0).length,
      review: active.filter((item) => item.status === "review").length,
      running: active.filter((item) => item.status === "running").length
    };
  }, [items]);

  async function moveItem(item, status) {
    if (status === item.status) return;
    try {
      await api(`/api/work-items/${item.id}`, { method: "PATCH", body: { status } });
      toast(`Moved to ${status}`, "ok");
      await queryClient.invalidateQueries({ queryKey: ["work-items"] });
    } catch (err) {
      toast(err.message, "error");
    }
  }

  if (error) {
    return (
      <>
        <Toolbar title="Work" />
        <section className="panel"><p className="muted">{error.message}</p></section>
      </>
    );
  }

  const lanes = showArchived ? [...BOARD_LANES, ARCHIVED_LANE] : BOARD_LANES;

  return (
    <>
      <Toolbar title="Work" shareHash={deepLinks.work()}>
        <input
          id="work-filter"
          className="work-filter"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {projects.length ? (
          <select id="work-project-filter" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : null}
        <label className="inline work-archived-toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
        </label>
        <button id="new-work-item" className="primary" onClick={() => setEditing("")}>New work item</button>
      </Toolbar>
      <section className="work-command" aria-label="Operator queue">
        <div className="work-command-copy">
          <p className="eyebrow">Start here</p>
          <h2>What needs action</h2>
          <p>
            Work items are outcomes. Runs are attempts. This queue stays focused on the next human move.
          </p>
        </div>
        <div className="work-command-stats" aria-label="Board summary">
          <span><strong>{boardTotals.needsDecision}</strong> need decision</span>
          <span><strong>{boardTotals.review}</strong> in review</span>
          <span><strong>{boardTotals.running}</strong> running</span>
          <span><strong>{boardTotals.active}</strong> active</span>
        </div>
        <div className="work-operator-list">
          {operatorItems.length ? operatorItems.map((item) => {
            const action = workItemAction(item);
            return (
              <a key={item.id} className={`work-operator-item tone-${action.tone}`} href={deepLinks.workItem(item.id)}>
                <span className="work-operator-label">{action.label}</span>
                <strong>{item.title}</strong>
                <span>{action.detail}</span>
              </a>
            );
          }) : (
            <div className="work-operator-empty">
              <strong>No immediate operator actions.</strong>
              <span>Ready items and new requests will appear here when they need a decision.</span>
            </div>
          )}
        </div>
      </section>
      {!items.length ? (
        <section className="work-empty-state panel">
          <p className="eyebrow">No active work</p>
          <h2>Capture the next outcome</h2>
          <p className="muted">
            Create a work item when there is something the company needs shipped, reviewed, or unblocked.
          </p>
          <button className="primary" onClick={() => setEditing("")}>Create work item</button>
        </section>
      ) : null}
      <div className="board" role="list" aria-label="Work board lanes">
        {lanes.map((lane) => {
          const laneItems = items.filter((item) => lane.statuses.includes(item.status));
          return (
            <section key={lane.id} className="board-col" data-lane={lane.id} role="listitem">
              <header className="board-col-header">
                <div>
                  <span>{lane.label}</span>
                  <p>{lane.hint}</p>
                </div>
                <Badge>{laneItems.length}</Badge>
              </header>
              <div className="board-col-cards">
                {laneItems.map((item) => (
                  <WorkCard key={item.id} item={item} onMove={moveItem} />
                ))}
                {!laneItems.length ? <p className="board-col-empty muted">{lane.empty}</p> : null}
              </div>
            </section>
          );
        })}
      </div>
      {editing !== null ? <WorkItemEditor id={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
