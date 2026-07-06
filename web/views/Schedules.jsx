import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks, navigate } from "../lib/router.js";
import { relativeTime, formatTimestamp } from "../lib/format.js";
import { toast } from "../lib/toast.js";
import { Toolbar, StatusBadge, ShareButton, Breadcrumbs, JsonBlock } from "../components/ui.jsx";
import { ScheduleEditor } from "../components/ScheduleEditor.jsx";

// Schedules area. Ported from legacy renderSchedules() / renderScheduleDetail()
// / editSchedule(). A schedule runs a workflow automatically on a cron schedule
// (or once at a future time); a scheduled run honors the workflow's approval
// policy exactly like running it by hand.

// --- shared cadence/chip helpers (ported from legacy) -----------------------

function cadenceLabel(schedule) {
  if (schedule.kind === "once") {
    return schedule.runAt ? `Once at ${formatTimestamp(schedule.runAt)}` : "One-time";
  }
  return schedule.preview?.description || `cron ${schedule.cron}`;
}

function NextChip({ schedule }) {
  if (!schedule.enabled) return <span className="chip muted" title="Disabled — will not fire">paused</span>;
  if (!schedule.nextRunAt) return <span className="chip muted" title="Nothing scheduled">no next run</span>;
  return (
    <span className="chip chip-next" title={`Next run ${formatTimestamp(schedule.nextRunAt)}`}>
      ⏭ {relativeTime(schedule.nextRunAt)}
    </span>
  );
}

function LastChip({ schedule }) {
  if (!schedule.lastRunAt) {
    return <span className="chip chip-last-run muted" title="Never fired">never run</span>;
  }
  const link = schedule.lastRunId ? (
    <a href={deepLinks.run(schedule.lastRunId)}>⏱ {relativeTime(schedule.lastRunAt)}</a>
  ) : (
    <>⏱ {relativeTime(schedule.lastRunAt)}</>
  );
  return (
    <>
      <span className="chip chip-last-run" title={`Last run ${formatTimestamp(schedule.lastRunAt)}`}>{link}</span>
      {schedule.lastStatus ? <> <StatusBadge value={schedule.lastStatus} /></> : null}
    </>
  );
}

// --- shared mutation handlers -----------------------------------------------

// Returns action handlers bound to the schedules query so list + detail share
// run-now / toggle / delete behavior. `onDeleted` lets the detail view bounce
// back to the list when the currently-open schedule is removed.
function useScheduleActions(onDeleted) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["schedules"] });

  async function runNow(id) {
    try {
      const result = await api(`/api/schedules/${id}/run-now`, { method: "POST", body: {} });
      toast("Run created from schedule", "ok");
      if (result?.run?.id) navigate(deepLinks.run(result.run.id));
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function toggle(id, currentlyEnabled) {
    try {
      await api(`/api/schedules/${id}/${currentlyEnabled ? "disable" : "enable"}`, { method: "POST", body: {} });
      toast(currentlyEnabled ? "Schedule disabled" : "Schedule enabled", "ok");
      await invalidate();
      if (onDeleted?.refresh) queryClient.invalidateQueries({ queryKey: ["schedule", id] });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function remove(id) {
    if (!window.confirm("Delete this schedule? This cannot be undone.")) return;
    try {
      await api(`/api/schedules/${id}`, { method: "DELETE" });
      toast("Schedule deleted", "ok");
      await invalidate();
      if (onDeleted?.id === id) navigate(deepLinks.schedules());
    } catch (error) {
      toast(error.message, "error");
    }
  }

  return { runNow, toggle, remove };
}

// Reusable action button cluster for a single schedule.
function ScheduleActions({ schedule, actions, onEdit }) {
  return (
    <>
      <button data-run-schedule={schedule.id} className="primary" title="Run this schedule now" onClick={() => actions.runNow(schedule.id)}>▶ Run now</button>
      <button data-toggle-schedule={schedule.id} data-enabled={schedule.enabled ? "1" : "0"} onClick={() => actions.toggle(schedule.id, schedule.enabled)}>{schedule.enabled ? "Disable" : "Enable"}</button>
      <button data-edit-schedule={schedule.id} onClick={() => onEdit(schedule.id)}>Edit</button>
      <button data-delete-schedule={schedule.id} className="danger" onClick={() => actions.remove(schedule.id)}>Delete</button>
    </>
  );
}

// --- list view --------------------------------------------------------------

function ScheduleCard({ schedule, actions, onEdit }) {
  return (
    <article className="item schedule-card" id={`schedule-${schedule.id}`}>
      <h3>
        <a href={deepLinks.schedule(schedule.id)}>{schedule.name}</a>{" "}
        <ShareButton hash={deepLinks.schedule(schedule.id)} label={`Copy share link to ${schedule.name}`} />
      </h3>
      {schedule.description ? <p className="muted workflow-desc">{schedule.description}</p> : null}
      <p className="workflow-meta">
        {schedule.capabilitySlug} · {cadenceLabel(schedule)}
        {schedule.timezone && schedule.timezone !== "UTC" ? ` · ${schedule.timezone}` : ""} · {schedule.enabled ? "enabled" : "disabled"}
      </p>
      <p className="workflow-run-chips"><NextChip schedule={schedule} /><LastChip schedule={schedule} /></p>
      <div className="toolbar-actions">
        <a className="button" href={deepLinks.schedule(schedule.id)}>Open</a>
        <ScheduleActions schedule={schedule} actions={actions} onEdit={onEdit} />
      </div>
    </article>
  );
}

export function Schedules() {
  const [editing, setEditing] = useState(null); // null=closed, ""=new, id=edit
  const { data, error } = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api("/api/schedules")
  });
  const actions = useScheduleActions();

  if (error) {
    return (
      <>
        <Toolbar title="Schedules" />
        <section className="panel"><p className="muted">{error.message}</p></section>
      </>
    );
  }

  const schedules = data?.schedules || [];

  return (
    <>
      <Toolbar title="Schedules" shareHash={deepLinks.schedules()}>
        <button id="new-schedule" className="primary" onClick={() => setEditing("")}>New Schedule</button>
      </Toolbar>
      <p className="muted">
        Schedules run a workflow automatically on a cron schedule (or once at a future time). A scheduled run honors the workflow's approval policy exactly like running it by hand.
      </p>
      {schedules.length ? (
        <div className="grid">
          {schedules.map((sched) => (
            <ScheduleCard key={sched.id} schedule={sched} actions={actions} onEdit={(id) => setEditing(id)} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <p>No schedules yet.</p>
          <p className="muted">Create one to run a workflow on a recurring cron schedule.</p>
        </div>
      )}
      {editing !== null ? (
        <ScheduleEditor id={editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

// --- detail view ------------------------------------------------------------

export function ScheduleDetail({ id }) {
  const [editing, setEditing] = useState(false);
  const { data, error } = useQuery({
    queryKey: ["schedule", id],
    queryFn: () => api(`/api/schedules/${id}`)
  });
  const actions = useScheduleActions({ id, refresh: true });

  if (error) {
    return (
      <>
        <Breadcrumbs items={[{ label: "Schedules", href: deepLinks.schedules() }, { label: "Schedule", current: true }]} />
        <Toolbar title="Schedule" />
        <section className="panel"><p className="muted">{error.message}</p></section>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <Breadcrumbs items={[{ label: "Schedules", href: deepLinks.schedules() }, { label: "Schedule", current: true }]} />
        <Toolbar title="Schedule" />
        <section className="panel"><p className="muted">Loading…</p></section>
      </>
    );
  }

  const schedule = data.schedule;
  const nextRuns = schedule.preview?.nextRuns || [];

  return (
    <>
      <Breadcrumbs items={[{ label: "Schedules", href: deepLinks.schedules() }, { label: schedule.name, current: true }]} />
      <Toolbar title={schedule.name} shareHash={deepLinks.schedule(schedule.id)}>
        <ScheduleActions schedule={schedule} actions={actions} onEdit={() => setEditing(true)} />
      </Toolbar>
      <p className="schedule-detail-sub"><NextChip schedule={schedule} /><LastChip schedule={schedule} /></p>
      <section className="split">
        <div className="panel schedule-main">
          {schedule.description ? <p>{schedule.description}</p> : null}
          <dl className="schedule-facts">
            <dt>Workflow</dt>
            <dd><a href={deepLinks.workflow(schedule.capabilitySlug)}>{schedule.capabilitySlug}</a></dd>
            <dt>Cadence</dt><dd>{cadenceLabel(schedule)}</dd>
            {schedule.kind === "cron" ? (
              <>
                <dt>Cron</dt><dd><span className="kbd">{schedule.cron}</span></dd>
              </>
            ) : null}
            <dt>Timezone</dt><dd>{schedule.timezone}</dd>
            <dt>Status</dt><dd>{schedule.enabled ? "Enabled" : "Disabled"}</dd>
            <dt>Created by</dt><dd>{schedule.createdBy || "—"}</dd>
          </dl>
          <h3>Input</h3>
          <JsonBlock value={schedule.input || {}} />
        </div>
        <aside className="panel schedule-side">
          <h3>Next runs</h3>
          {nextRuns.length ? (
            <ul className="schedule-next-list">
              {nextRuns.map((iso) => (
                <li key={iso}>
                  <span title={iso}>{formatTimestamp(iso)}</span> <span className="muted">{relativeTime(iso)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{schedule.enabled ? "No upcoming runs." : "Schedule is disabled."}</p>
          )}
        </aside>
      </section>
      {editing ? <ScheduleEditor id={schedule.id} onClose={() => setEditing(false)} /> : null}
    </>
  );
}
