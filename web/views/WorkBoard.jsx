import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { relativeTime } from "../lib/format.js";
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
  const [boardSlug, setBoardSlug] = useState("");
  const [dragItemId, setDragItemId] = useState("");
  const [dropLaneId, setDropLaneId] = useState("");
  const [optimisticStatuses, setOptimisticStatuses] = useState({});
  const queryClient = useQueryClient();

  const { data, error } = useQuery({
    queryKey: ["work-items", { includeArchived: showArchived }],
    queryFn: () => api(`/api/work-items${showArchived ? "?includeArchived=true" : ""}`),
    refetchInterval: 15_000
  });

  // Board instances: durable configured views (lanes, project scope, title).
  // The default board is this deployment's own factory surface; more can be
  // created via API/CLI/MCP and picked here.
  const { data: boardsData } = useQuery({
    queryKey: ["boards"],
    queryFn: () => api("/api/boards")
  });
  const boards = boardsData?.boards || [];
  const board = boards.find((b) => b.slug === boardSlug) || boards.find((b) => b.isDefault) || boards[0] || null;
  const rawItems = useMemo(() => data?.workItems || [], [data]);

  useEffect(() => {
    setOptimisticStatuses((current) => {
      let changed = false;
      const next = {};
      for (const [id, status] of Object.entries(current)) {
        const item = rawItems.find((candidate) => candidate.id === id);
        if (!item || item.status === status) {
          changed = true;
        } else {
          next[id] = status;
        }
      }
      return changed ? next : current;
    });
  }, [rawItems]);

  const items = useMemo(() => {
    const all = rawItems.map((item) => (
      optimisticStatuses[item.id] && optimisticStatuses[item.id] !== item.status
        ? { ...item, status: optimisticStatuses[item.id] }
        : item
    ));
    const q = filter.trim().toLowerCase();
    return all.filter((item) => {
      if (board?.project && item.project !== board.project) return false;
      if (project && item.project !== project) return false;
      if (!q) return true;
      return [item.title, item.description, item.project, item.owner, item.id]
        .some((field) => String(field || "").toLowerCase().includes(q));
    });
  }, [rawItems, optimisticStatuses, filter, project, board]);

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
    setOptimisticStatus(item.id, status);
    try {
      await api(`/api/work-items/${item.id}`, { method: "PATCH", body: { status } });
      toast(`Moved to ${status}`, "ok");
      await queryClient.invalidateQueries({ queryKey: ["work-items"] });
    } catch (err) {
      setOptimisticStatus(item.id, item.status);
      toast(err.message, "error");
    }
  }

  function setOptimisticStatus(id, status) {
    const apply = () => {
      setOptimisticStatuses((current) => ({ ...current, [id]: status }));
    };
    if (typeof document !== "undefined" && typeof document.startViewTransition === "function") {
      document.startViewTransition(apply);
    } else {
      apply();
    }
  }

  function beginDrag(event, item) {
    setDragItemId(item.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-runyard-work-item", item.id);
    event.dataTransfer.setData("text/plain", item.id);
  }

  function endDrag() {
    setDragItemId("");
    setDropLaneId("");
  }

  function dragOverLane(event, lane) {
    if (!dragItemId || !lane.statuses?.length) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropLaneId !== lane.id) setDropLaneId(lane.id);
  }

  function leaveLane(event, lane) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (dropLaneId === lane.id) setDropLaneId("");
  }

  function dropOnLane(event, lane) {
    event.preventDefault();
    const id = event.dataTransfer.getData("application/x-runyard-work-item") || dragItemId;
    const item = items.find((candidate) => candidate.id === id);
    setDropLaneId("");
    setDragItemId("");
    if (!item || !lane.statuses?.length) return;
    moveItem(item, lane.statuses[0]);
  }

  if (error) {
    return (
      <>
        <Toolbar title="Work" />
        <section className="panel"><p className="muted">{error.message}</p></section>
      </>
    );
  }

  const baseLanes = board?.lanes?.length ? board.lanes : BOARD_LANES;
  const lanes = showArchived ? [...baseLanes, ARCHIVED_LANE] : baseLanes;

  return (
    <>
      <Toolbar title={board?.title || "Work"} shareHash={deepLinks.work()}>
        {boards.length > 1 ? (
          <select
            id="work-board-picker"
            className="work-project-filter"
            value={board?.slug || ""}
            onChange={(e) => setBoardSlug(e.target.value)}
            aria-label="Board"
          >
            {boards.map((b) => <option key={b.slug} value={b.slug}>{b.title}</option>)}
          </select>
        ) : null}
        <input
          id="work-filter"
          className="work-filter"
          type="search"
          placeholder="Filter work…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {projects.length ? (
          <select
            id="work-project-filter"
            className="work-project-filter"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            aria-label="Filter by project"
          >
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
        <header className="work-command-head">
          <div className="work-command-copy">
            <h2>What needs action</h2>
            <p>{board?.description || "Work items are outcomes; runs are attempts. This queue is the next human move."}</p>
          </div>
          <dl className="work-command-stats" aria-label="Board summary">
            <div className={boardTotals.needsDecision ? "is-signal" : ""}>
              <dd>{boardTotals.needsDecision}</dd>
              <dt>need decision</dt>
            </div>
            <div>
              <dd>{boardTotals.review}</dd>
              <dt>in review</dt>
            </div>
            <div>
              <dd>{boardTotals.running}</dd>
              <dt>running</dt>
            </div>
            <div>
              <dd>{boardTotals.active}</dd>
              <dt>active</dt>
            </div>
          </dl>
        </header>
        <div className="work-operator-list">
          {operatorItems.length ? operatorItems.map((item) => {
            const action = workItemAction(item);
            return (
              <a key={item.id} className={`work-operator-item tone-${action.tone}`} href={deepLinks.workItem(item.id)}>
                <span className="work-operator-label">{action.label}</span>
                <span className="work-operator-body">
                  <strong>{item.title}</strong>
                  <span className="work-operator-detail">{action.detail}</span>
                </span>
                <span className="work-operator-meta">
                  {item.project ? <span className="work-operator-project">{item.project}</span> : null}
                  <span title={item.updatedAt}>{relativeTime(item.updatedAt)}</span>
                </span>
                <span className="work-operator-go" aria-hidden="true">→</span>
              </a>
            );
          }) : (
            <div className="work-operator-empty">
              <span className="work-operator-clear" aria-hidden="true">✓</span>
              <span>
                <strong>All clear — nothing needs a decision right now.</strong>{" "}
                <span className="work-operator-detail">Ready items and new requests surface here the moment they need you.</span>
              </span>
            </div>
          )}
        </div>
      </section>
      {!items.length ? (
        <section className="work-empty-state panel">
          <div>
            <p className="eyebrow">No active work</p>
            <h2>Capture the next outcome</h2>
            <p className="muted">
              Create a work item when there is something the company needs shipped, reviewed, or unblocked.
            </p>
          </div>
          <button className="primary" onClick={() => setEditing("")}>Create work item</button>
        </section>
      ) : null}
      <div className="board-scroller">
        <div className="board" role="list" aria-label="Work board lanes">
          {lanes.map((lane) => {
            const laneItems = items.filter((item) => lane.statuses.includes(item.status));
            return (
              <section
                key={lane.id}
                className={`board-col${dropLaneId === lane.id ? " is-drop-target" : ""}`}
                data-lane={lane.id}
                role="listitem"
                onDragOver={(e) => dragOverLane(e, lane)}
                onDragLeave={(e) => leaveLane(e, lane)}
                onDrop={(e) => dropOnLane(e, lane)}
              >
                <header className="board-col-header">
                  <span className="board-col-dot" aria-hidden="true" />
                  <span className="board-col-label">{lane.label}</span>
                  <Badge>{laneItems.length}</Badge>
                </header>
                <p className="board-col-hint" title={lane.hint}>{lane.hint}</p>
                <div className="board-col-cards">
                  {laneItems.map((item) => (
                    <WorkCard
                      key={item.id}
                      item={item}
                      dragging={dragItemId === item.id}
                      onDragStart={beginDrag}
                      onDragEnd={endDrag}
                    />
                  ))}
                  {!laneItems.length ? <p className="board-col-empty muted">{lane.empty}</p> : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {editing !== null ? <WorkItemEditor id={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}
