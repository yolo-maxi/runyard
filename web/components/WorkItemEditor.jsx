import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from "../lib/workItems.js";

// Inline work-item editor (ScheduleEditor is the pattern): a `.panel` form,
// create mode (id="") and edit mode (id set). Only fields the operator
// touched are PATCHed on edit; create sends the full draft.

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

  if (!draft) {
    return (
      <section id="editor" className="panel">
        <p className="muted">Loading…</p>
      </section>
    );
  }

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
    <section id="editor" className="panel">
      <h2>{editing ? "Edit" : "New"} work item</h2>
      <form id="work-item-form" className="form-grid" onSubmit={submit}>
        <label>Title <span className="req">*</span>
          <input id="wi-title" value={draft.title} onChange={(e) => set({ title: e.target.value })} required />
        </label>
        <label>Goal / description
          <textarea id="wi-description" placeholder="What are we trying to do, and why?" value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label>Project
          <input id="wi-project" value={draft.project} onChange={(e) => set({ project: e.target.value })} />
        </label>
        <label>Type
          <select id="wi-type" value={draft.type} onChange={(e) => set({ type: e.target.value })}>
            {WORK_ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>Status
          <select id="wi-status" value={draft.status} onChange={(e) => set({ status: e.target.value })}>
            {WORK_ITEM_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>Priority
          <select id="wi-priority" value={draft.priority} onChange={(e) => set({ priority: e.target.value })}>
            {WORK_ITEM_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>Owner
          <input id="wi-owner" placeholder="who owns the next action" value={draft.owner} onChange={(e) => set({ owner: e.target.value })} />
        </label>
        <label>Requester
          <input id="wi-requester" value={draft.requester} onChange={(e) => set({ requester: e.target.value })} />
        </label>
        <label>Acceptance criteria
          <textarea id="wi-acceptance" placeholder="How will we know the ask is satisfied?" value={draft.acceptanceCriteria} onChange={(e) => set({ acceptanceCriteria: e.target.value })} />
        </label>
        <label>Next action
          <input id="wi-next-action" placeholder="the single next concrete action" value={draft.nextAction} onChange={(e) => set({ nextAction: e.target.value })} />
        </label>
        <label>Blocked reason
          <input id="wi-blocked-reason" placeholder="set when status is blocked" value={draft.blockedReason} onChange={(e) => set({ blockedReason: e.target.value })} />
        </label>
        <label>Due / target
          <input id="wi-due" type="datetime-local" value={draft.dueAt} onChange={(e) => set({ dueAt: e.target.value })} />
        </label>
        <button className="primary" type="submit">{editing ? "Save work item" : "Create work item"}</button>
      </form>
    </section>
  );
}
