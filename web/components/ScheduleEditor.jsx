import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { api } from "../lib/api.js";
import { capabilitiesCollection } from "../lib/collections.js";
import { deepLinks, navigate } from "../lib/router.js";
import { relativeTime, formatTimestamp } from "../lib/format.js";
import { toast } from "../lib/toast.js";

// Inline schedule editor. Ported from legacy editSchedule() + bindCronPreview().
// Renders into a `.panel` that mirrors the legacy `#editor` section so
// styles.css applies unchanged. The kind toggle (cron vs once) shows/hides the
// cron+timezone group vs the run-at group.

const CRON_PRESETS = [
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 09:00", cron: "0 9 * * *" },
  { label: "Weekdays 09:00", cron: "0 9 * * 1-5" },
  { label: "Weekly Mon 09:00", cron: "0 9 * * 1" }
];

// Convert an ISO timestamp to a value usable by <input type="datetime-local">
// (local time, no timezone suffix). Empty string when absent/invalid.
function toLocalDatetimeValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Debounced live cron preview. Validates the expression server-side and shows
// the human description + next fire times as the operator types. The debounce
// stores the latest cron/timezone in state after a 250ms settle, and the query
// is only enabled once a (debounced) cron is present.
function CronPreview({ cron, timezone }) {
  const [debounced, setDebounced] = useState({ cron: cron.trim(), timezone });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced({ cron: cron.trim(), timezone: (timezone || "UTC").trim() || "UTC" });
    }, 250);
    return () => clearTimeout(timer);
  }, [cron, timezone]);

  const { data, error } = useQuery({
    queryKey: ["schedule-preview", debounced.cron, debounced.timezone],
    queryFn: () => api(`/api/schedules/preview?cron=${encodeURIComponent(debounced.cron)}&timezone=${encodeURIComponent(debounced.timezone)}`),
    enabled: Boolean(debounced.cron)
  });

  if (!debounced.cron) {
    return <div id="schedule-preview" className="schedule-preview muted">Enter a cron expression to preview the schedule.</div>;
  }
  if (error) {
    return <div id="schedule-preview" className="schedule-preview invalid">{error.message}</div>;
  }
  if (!data) {
    return <div id="schedule-preview" className="schedule-preview muted">Validating…</div>;
  }
  if (!data.valid) {
    return <div id="schedule-preview" className="schedule-preview invalid">Invalid: {data.error}</div>;
  }
  return (
    <div id="schedule-preview" className="schedule-preview valid">
      <strong>{data.description}</strong>
      <ul className="schedule-next-list">
        {(data.nextRuns || []).map((iso) => (
          <li key={iso}>
            <span title={iso}>{formatTimestamp(iso)}</span> <span className="muted">{relativeTime(iso)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ScheduleEditor({ id = "", onClose }) {
  const queryClient = useQueryClient();
  const editing = Boolean(id);

  // Existing schedule (when editing) feeds the initial draft.
  const { data: scheduleData } = useQuery({
    queryKey: ["schedule", id],
    queryFn: () => api(`/api/schedules/${id}`),
    enabled: editing
  });

  // Workflow picker options via the shared capabilities collection.
  const { data: capabilities = [] } = useLiveQuery((q) => capabilitiesCollection);

  const [draft, setDraft] = useState(null);

  // Initialize the form once the (optional) existing schedule has loaded.
  useEffect(() => {
    if (draft) return;
    if (editing && !scheduleData) return;
    const schedule = scheduleData?.schedule || null;
    const base = schedule || {
      name: "", description: "", capabilitySlug: "", cron: "", timezone: "UTC",
      input: {}, kind: "cron", runAt: "", enabled: true
    };
    setDraft({
      name: base.name || "",
      description: base.description || "",
      capabilitySlug: base.capabilitySlug || "",
      kind: base.kind === "once" ? "once" : "cron",
      cron: base.cron || "",
      timezone: base.timezone || "UTC",
      runAt: toLocalDatetimeValue(base.runAt),
      input: JSON.stringify(base.input || {}, null, 2),
      enabled: base.enabled !== false
    });
  }, [editing, scheduleData, draft]);

  if (!draft) {
    return (
      <section id="editor" className="panel">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const isOnce = draft.kind === "once";

  async function submit(event) {
    event.preventDefault();
    const name = draft.name.trim();
    const capabilitySlug = draft.capabilitySlug;
    if (!name) return toast("Name is required", "error");
    if (!capabilitySlug) return toast("Choose a workflow", "error");
    let input;
    try {
      input = JSON.parse(draft.input || "{}");
    } catch {
      return toast("Input is not valid JSON", "error");
    }
    const payload = {
      name,
      description: draft.description.trim(),
      capabilitySlug,
      input,
      enabled: draft.enabled
    };
    if (draft.kind === "once") {
      if (!draft.runAt) return toast("Pick a run-at time", "error");
      payload.runAt = new Date(draft.runAt).toISOString();
      payload.cron = "";
    } else {
      payload.cron = draft.cron.trim();
      payload.timezone = (draft.timezone || "UTC").trim() || "UTC";
      payload.runAt = null;
      if (!payload.cron) return toast("Cron expression is required", "error");
    }
    try {
      const saved = editing
        ? await api(`/api/schedules/${id}`, { method: "PATCH", body: payload })
        : await api("/api/schedules", { method: "POST", body: payload });
      toast("Schedule saved", "ok");
      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
      if (editing) await queryClient.invalidateQueries({ queryKey: ["schedule", id] });
      const segments = deepLinks.parse().segments;
      // If we're on a detail page, follow the saved schedule there.
      if (segments[0] === "schedules" && segments[1] && saved?.schedule?.id) {
        navigate(deepLinks.schedule(saved.schedule.id));
      }
      onClose?.();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  return (
    <section id="editor" className="panel">
      <h2>{editing ? "Edit" : "New"} Schedule</h2>
      <form id="schedule-form" className="form-grid" onSubmit={submit}>
        <label>Name <span className="req">*</span>
          <input id="sched-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} required />
        </label>
        <label>Description
          <input id="sched-description" value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label>Workflow <span className="req">*</span>
          <select id="sched-cap" required value={draft.capabilitySlug} onChange={(e) => set({ capabilitySlug: e.target.value })}>
            <option value="">Choose a workflow…</option>
            {capabilities.map((cap) => (
              <option key={cap.slug} value={cap.slug}>{cap.name} ({cap.slug})</option>
            ))}
          </select>
        </label>
        <label>Schedule type
          <select id="sched-kind" value={draft.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="cron">Recurring (cron)</option>
            <option value="once">One-time</option>
          </select>
        </label>
        <div id="sched-cron-group" className={isOnce ? "hidden" : ""}>
          <label>Cron expression <span className="req">*</span>
            <input id="sched-cron" placeholder="0 9 * * 1-5" value={draft.cron} onChange={(e) => set({ cron: e.target.value })} />
            <span className="field-hint">minute hour day-of-month month day-of-week. Names &amp; @aliases (@daily, @hourly) are supported.</span>
          </label>
          <div className="cron-presets">
            {CRON_PRESETS.map((p) => (
              <button type="button" key={p.cron} className="chip cron-preset" data-cron={p.cron} onClick={() => set({ cron: p.cron })}>{p.label}</button>
            ))}
          </div>
          <label>Timezone
            <input id="sched-timezone" value={draft.timezone} placeholder="UTC" onChange={(e) => set({ timezone: e.target.value })} />
            <span className="field-hint">IANA timezone, e.g. UTC, America/New_York, Europe/Rome.</span>
          </label>
          <CronPreview cron={draft.cron} timezone={draft.timezone} />
        </div>
        <div id="sched-once-group" className={isOnce ? "" : "hidden"}>
          <label>Run at <span className="req">*</span>
            <input id="sched-runat" type="datetime-local" value={draft.runAt} onChange={(e) => set({ runAt: e.target.value })} />
            <span className="field-hint">Fires once at this local time, then disables itself.</span>
          </label>
        </div>
        <label>Input (JSON)
          <textarea id="sched-input" data-ftype="json" placeholder="{}" value={draft.input} onChange={(e) => set({ input: e.target.value })} />
          <span className="field-hint">Forwarded to the workflow on each run.</span>
        </label>
        <label className="inline">
          <input type="checkbox" id="sched-enabled" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
        </label>
        <button className="primary" type="submit">{editing ? "Save schedule" : "Create schedule"}</button>
      </form>
    </section>
  );
}
