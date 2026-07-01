import { now } from "./ids.js";
import { notifyPendingApprovalForRun } from "./pendingApprovalNotifications.js";
import { actorName } from "./routeActors.js";
import { runStatusLinks } from "./runHttpPresentation.js";
import { schedulePreview, validateScheduleBody, withScheduleView } from "./scheduleHelpers.js";

export function createScheduleHandlers({
  addRunEvent,
  claimScheduleFire,
  createSchedule,
  deleteSchedule,
  dispatchRun,
  getCapability,
  getSchedule,
  listApprovals,
  listDueSchedules,
  listSchedules,
  notifyTelegram,
  recordAudit,
  recordScheduleFireResult,
  setScheduleEnabled,
  updateSchedule,
  withRunLinks
} = {}) {
  const scheduleOr404 = (req, res) => {
    const schedule = getSchedule(req.params.id);
    if (!schedule) {
      res.status(404).json({ error: "schedule not found" });
      return null;
    }
    return schedule;
  };

  const sendValidationError = (res, validated) => {
    if (validated.ok) return false;
    res.status(400).json({ error: validated.error });
    return true;
  };

  const setScheduleEnabledRoute = (req, res, enabled) => {
    if (!scheduleOr404(req, res)) return;
    const schedule = setScheduleEnabled(req.params.id, enabled);
    recordAudit(actorName(req.token), enabled ? "schedule.enabled" : "schedule.disabled", schedule.id, {});
    res.json({ schedule: withScheduleView(schedule) });
  };

  function runScheduleNow(schedule, { trigger = "manual", actor = "" } = {}) {
    const capability = getCapability(schedule.capabilitySlug);
    if (!capability || !capability.enabled) {
      return { ok: false, error: `capability "${schedule.capabilitySlug}" is unavailable` };
    }
    const input = schedule.input && typeof schedule.input === "object" && !Array.isArray(schedule.input)
      ? { ...schedule.input }
      : {};
    const requestedBy = `schedule: ${schedule.name}`;
    const origin = {
      type: "schedule",
      label: `schedule: ${schedule.name}`,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      trigger
    };
    const dispatched = dispatchRun(capability, input, { requestedBy, origin });
    const runRecord = dispatched.run;
    addRunEvent(runRecord.id, "run.scheduled", `Created by schedule "${schedule.name}"`, {
      scheduleId: schedule.id,
      cron: schedule.cron || "",
      timezone: schedule.timezone,
      trigger
    });
    recordScheduleFireResult(schedule.id, runRecord.id, runRecord.status);
    recordAudit(actor || requestedBy, "schedule.fired", schedule.id, {
      runId: runRecord.id,
      capability: schedule.capabilitySlug,
      trigger
    });
    return { ok: true, run: runRecord, dispatched };
  }

  function fireDueSchedules(nowIso = now()) {
    const firedRunIds = [];
    for (const schedule of listDueSchedules(nowIso)) {
      try {
        const claim = claimScheduleFire(schedule.id, schedule.nextRunAt, nowIso);
        if (!claim.ok) continue;
        const result = runScheduleNow(schedule, { trigger: "ticker", actor: `schedule:${schedule.id}` });
        if (result.ok) {
          firedRunIds.push(result.run.id);
          notifyPendingApprovalForRun(result.run.id, { listApprovals, notifyTelegram }).catch(() => {});
        } else {
          recordScheduleFireResult(schedule.id, null, `error: ${result.error}`.slice(0, 80));
          recordAudit(`schedule:${schedule.id}`, "schedule.fire_failed", schedule.id, { error: result.error });
        }
      } catch (error) {
        recordAudit(`schedule:${schedule.id}`, "schedule.fire_failed", schedule.id, { error: error.message });
      }
    }
    return firedRunIds;
  }

  return {
    runScheduleNow,
    fireDueSchedules,

    listSchedules(_req, res) {
      res.json({ schedules: listSchedules().map(withScheduleView) });
    },

    previewSchedule(req, res) {
      const cron = String(req.query.cron || "").trim();
      const timezone = String(req.query.timezone || "UTC").trim() || "UTC";
      const preview = schedulePreview(cron, timezone);
      if (!preview.ok) return res.status(preview.status).json({ error: preview.error });
      res.json(preview.value);
    },

    getSchedule(req, res) {
      const schedule = scheduleOr404(req, res);
      if (!schedule) return;
      res.json({ schedule: withScheduleView(schedule) });
    },

    createSchedule(req, res) {
      const validated = validateScheduleBody(req.body || {}, { partial: false, getCapability });
      if (sendValidationError(res, validated)) return;
      const schedule = createSchedule({
        ...validated.value,
        createdBy: actorName(req.token)
      });
      recordAudit(actorName(req.token), "schedule.created", schedule.id, {
        capability: schedule.capabilitySlug,
        cron: schedule.cron || "",
        runAt: schedule.runAt || ""
      });
      res.status(201).json({ schedule: withScheduleView(schedule) });
    },

    updateSchedule(req, res) {
      if (!scheduleOr404(req, res)) return;
      const validated = validateScheduleBody(req.body || {}, { partial: true, getCapability });
      if (sendValidationError(res, validated)) return;
      const schedule = updateSchedule(req.params.id, validated.value);
      recordAudit(actorName(req.token), "schedule.updated", schedule.id, { fields: Object.keys(validated.value) });
      res.json({ schedule: withScheduleView(schedule) });
    },

    enableSchedule(req, res) {
      setScheduleEnabledRoute(req, res, true);
    },

    disableSchedule(req, res) {
      setScheduleEnabledRoute(req, res, false);
    },

    deleteSchedule(req, res) {
      const deleted = deleteSchedule(req.params.id);
      if (!deleted) return res.status(404).json({ error: "schedule not found" });
      recordAudit(actorName(req.token), "schedule.deleted", req.params.id, { name: deleted.name });
      res.json({ deleted: true, schedule: withScheduleView(deleted) });
    },

    async runScheduleNowRoute(req, res) {
      const schedule = scheduleOr404(req, res);
      if (!schedule) return;
      const result = runScheduleNow(schedule, { trigger: "manual", actor: actorName(req.token) });
      if (!result.ok) return res.status(409).json({ error: result.error });
      await notifyPendingApprovalForRun(result.run.id, { listApprovals, notifyTelegram });
      res.status(202).json(scheduleRunNowResponse({
        result,
        schedule: getSchedule(req.params.id),
        withRunLinks
      }));
    }
  };
}

export function scheduleRunNowResponse({ result, schedule, withRunLinks }) {
  return {
    run: withRunLinks(result.run),
    ...(result.dispatched.supervising ? { supervising: result.dispatched.supervising } : {}),
    schedule: withScheduleView(schedule),
    ...runStatusLinks(result.run.id)
  };
}
