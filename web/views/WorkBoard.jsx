import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { toast } from "../lib/toast.js";
import { Badge, Toolbar } from "../components/ui.jsx";
import { WorkCard } from "../components/WorkCard.jsx";
import { WorkItemEditor } from "../components/WorkItemEditor.jsx";
import { ARCHIVED_LANE, BOARD_LANES } from "../lib/workItems.js";

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
    () => [...new Set((data?.workItems || []).map((item) => item.project).filter(Boolean))].sort(),
    [data]
  );

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
      <p className="muted">
        Work items are the durable unit of company work. Workflows are the recipes; runs are single attempts.
        A failed run never fails a ticket — move it to blocked, review, or waiting with a reason instead.
      </p>
      <div className="board" role="list" aria-label="Work board lanes">
        {lanes.map((lane) => {
          const laneItems = items.filter((item) => lane.statuses.includes(item.status));
          return (
            <section key={lane.id} className="board-col" data-lane={lane.id} role="listitem">
              <header className="board-col-header">
                <span>{lane.label}</span> <Badge>{laneItems.length}</Badge>
              </header>
              <div className="board-col-cards">
                {laneItems.map((item) => (
                  <WorkCard key={item.id} item={item} onMove={moveItem} />
                ))}
                {!laneItems.length ? <p className="board-col-empty muted">—</p> : null}
              </div>
            </section>
          );
        })}
      </div>
      {editing !== null ? <WorkItemEditor id={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
