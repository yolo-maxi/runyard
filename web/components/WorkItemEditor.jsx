import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from "../lib/workItems.js";

// Work-item editor modal: create mode (id="") and edit mode (id set). A tight
// two-column dialog instead of a form dumped under the board — closes on
// Escape, backdrop click, or Cancel. Only fields the operator touched matter
// on edit (the PATCH sends the full draft; the server treats it as the new
// truth for these fields).

function toLocalDatetimeValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function WorkItemEditor({ id = "", onClose }) {
  const queryClient = useQueryClient();
  const editing = Boolean(id);

  const { data: existingData } = useQuery({
    queryKey: ["work-item", id],
    queryFn: () => api(`/api/work-items/${id}`),
    enabled: editing
  });

  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (draft) return;
    if (editing && !existingData) return;
    const item = existingData?.workItem || null;
    setDraft({
      title: item?.title || "",
      description: item?.description || "",
      project: item?.project || "",
      type: item?.type || "feature",
      status: item?.status || "intake",
      priority: item?.priority || "normal",
      owner: item?.owner || "",
      requester: item?.requester || "",
      acceptanceCriteria: item?.acceptanceCriteria || "",
      nextAction: item?.nextAction || "",
      blockedReason: item?.blockedReason || "",
      dueAt: toLocalDatetimeValue(item?.dueAt)
    });
  }, [editing, existingData, draft]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  async function submit(event) {
    event.preventDefault();
    if (!draft.title.trim()) return toast("Title is required", "error");
    const payload = {
      title: draft.title.trim(),
      description: draft.description,
      project: draft.project.trim(),
      type: draft.type,
      status: draft.status,
      priority: draft.priority,
      owner: draft.owner.trim(),
      requester: draft.requester.trim(),
      acceptanceCriteria: draft.acceptanceCriteria,
      nextAction: draft.nextAction,
      blockedReason: draft.blockedReason,
      dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : null
    };
    try {
      editing
        ? await api(`/api/work-items/${id}`, { method: "PATCH", body: payload })
        : await api("/api/work-items", { method: "POST", body: payload });
      toast("Work item saved", "ok");
      await queryClient.invalidateQueries({ queryKey: ["work-items"] });
      if (editing) await queryClient.invalidateQueries({ queryKey: ["work-item", id] });
      onClose?.();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  return (
    <div
      className="work-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <section
        id="editor"
        className="panel work-modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Edit work item" : "New work item"}
      >
        <header className="work-modal-head">
          <h2>{editing ? "Edit work item" : "New work item"}</h2>
          <button type="button" className="btn-sm btn-icon work-modal-close" aria-label="Close" onClick={() => onClose?.()}>
            ×
          </button>
        </header>
        {!draft ? (
          <p className="muted">Loading…</p>
        ) : (
          <form id="work-item-form" className="form-grid work-editor-grid" onSubmit={submit}>
            <label className="span-2"><span>Title <span className="req">*</span></span>
              <input id="wi-title" value={draft.title} onChange={(e) => set({ title: e.target.value })} required autoFocus />
            </label>
            <label className="span-2">Goal / description
              <textarea id="wi-description" rows={3} placeholder="What are we trying to do, and why?" value={draft.description} onChange={(e) => set({ description: e.target.value })} />
            </label>
            <label>Type
              <select id="wi-type" value={draft.type} onChange={(e) => set({ type: e.target.value })}>
                {WORK_ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label>Priority
              <select id="wi-priority" value={draft.priority} onChange={(e) => set({ priority: e.target.value })}>
                {WORK_ITEM_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>Status
              <select id="wi-status" value={draft.status} onChange={(e) => set({ status: e.target.value })}>
                {WORK_ITEM_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>Project
              <input id="wi-project" value={draft.project} onChange={(e) => set({ project: e.target.value })} />
            </label>
            <label>Owner
              <input id="wi-owner" placeholder="who owns the next action" value={draft.owner} onChange={(e) => set({ owner: e.target.value })} />
            </label>
            <label>Requester
              <input id="wi-requester" value={draft.requester} onChange={(e) => set({ requester: e.target.value })} />
            </label>
            <label className="span-2">Next action
              <input id="wi-next-action" placeholder="the single next concrete action" value={draft.nextAction} onChange={(e) => set({ nextAction: e.target.value })} />
            </label>
            <label className="span-2">Acceptance criteria
              <textarea id="wi-acceptance" rows={2} placeholder="How will we know the ask is satisfied?" value={draft.acceptanceCriteria} onChange={(e) => set({ acceptanceCriteria: e.target.value })} />
            </label>
            <label>Blocked reason
              <input id="wi-blocked-reason" placeholder="set when status is blocked" value={draft.blockedReason} onChange={(e) => set({ blockedReason: e.target.value })} />
            </label>
            <label>Due / target
              <input id="wi-due" type="datetime-local" value={draft.dueAt} onChange={(e) => set({ dueAt: e.target.value })} />
            </label>
            <footer className="work-modal-actions span-2">
              <button type="button" onClick={() => onClose?.()}>Cancel</button>
              <button className="primary" type="submit">{editing ? "Save work item" : "Create work item"}</button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
