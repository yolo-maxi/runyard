import {
  normalizeSchedule,
  scheduleClaimDecision,
  scheduleCreateRecord,
  scheduleDeleteQuery,
  dueSchedulesQuery,
  scheduleClaimUpdateQuery,
  scheduleFireResultUpdateQuery,
  scheduleInsertQuery,
  scheduleListQuery,
  scheduleLookupQuery,
  scheduleAutoDisableQuery,
  scheduleRunTerminalUpdateQuery,
  scheduleUpdateQuery,
  scheduleUpdateValues
} from "./scheduleRecords.js";
import { RUN_TERMINAL } from "./runLifecyclePolicy.js";

const BROKEN_STATUS = "broken_reference";

function scheduleReferenceProblem(schedule, getCapability) {
  if (!schedule?.capabilitySlug || !getCapability) return null;
  const capability = getCapability(schedule.capabilitySlug);
  if (!capability) return `workflow "${schedule.capabilitySlug}" is missing`;
  if (!capability.enabled) return `workflow "${schedule.capabilitySlug}" is disabled`;
  return null;
}

export function createScheduleStore({ all, one, run, id, now, getCapability = null, recordAudit = null }) {
  function getSchedule(idValue) {
    const query = scheduleLookupQuery(idValue);
    return reconcileScheduleView(reconcileScheduleLastRun(normalizeSchedule(one(query.sql, query.params))));
  }

  function createSchedule(input) {
    const timestamp = now();
    const record = scheduleCreateRecord({ id: id("sched"), input, timestamp });
    const query = scheduleInsertQuery();
    run(query.sql, record);
    return getSchedule(record.id);
  }

  function listSchedules({ includeDisabled = true } = {}) {
    const query = scheduleListQuery({ includeDisabled });
    return all(query.sql, query.params).map(normalizeSchedule).map(reconcileScheduleLastRun).map(reconcileScheduleView);
  }

  function updateSchedule(idValue, updates = {}) {
    const lookup = scheduleLookupQuery(idValue);
    const existing = one(lookup.sql, lookup.params);
    if (!existing) return null;
    const timestamp = now();
    const query = scheduleUpdateQuery({ idValue, values: scheduleUpdateValues(existing, updates, timestamp) });
    run(query.sql, query.params);
    return getSchedule(idValue);
  }

  function setScheduleEnabled(idValue, enabled) {
    return updateSchedule(idValue, { enabled: Boolean(enabled) });
  }

  function deleteSchedule(idValue) {
    const existing = getSchedule(idValue);
    if (!existing) return null;
    const query = scheduleDeleteQuery(idValue);
    run(query.sql, query.params);
    return existing;
  }

  function listDueSchedules(nowIso = now()) {
    const query = dueSchedulesQuery(nowIso);
    return all(query.sql, query.params).map(normalizeSchedule).map(reconcileScheduleLastRun).map(reconcileScheduleView);
  }

  // Atomically claim a due schedule for firing. Recomputes next_run_at strictly
  // after `nowIso` so missed ticks collapse to one catch-up fire.
  function claimScheduleFire(idValue, expectedNextRunAt, nowIso = now()) {
    const lookup = scheduleLookupQuery(idValue);
    const row = one(lookup.sql, lookup.params);
    const decision = scheduleClaimDecision(row, expectedNextRunAt, nowIso);
    if (!decision.ok) return decision;
    const query = scheduleClaimUpdateQuery({ idValue, expectedNextRunAt, decision, nowIso });
    const result = run(query.sql, query.params);
    if (!result.changes) return { ok: false, reason: "raced" };
    return { ok: true, schedule: getSchedule(idValue) };
  }

  // Record fire outcome without touching next_run_at; claimScheduleFire owns
  // the cadence and idempotent next-run update.
  function recordScheduleFireResult(idValue, runId, status = "queued", firedAtIso = now()) {
    const query = scheduleFireResultUpdateQuery({ idValue, runId, status, firedAtIso, updatedAt: now() });
    run(query.sql, query.params);
    return getSchedule(idValue);
  }

  function autoDisableSchedule(idValue, reason, actor = "system") {
    const query = scheduleAutoDisableQuery({
      idValue,
      reason,
      status: BROKEN_STATUS,
      updatedAt: now()
    });
    const result = run(query.sql, query.params);
    const schedule = getSchedule(idValue);
    if (result.changes && recordAudit && schedule) {
      recordAudit(actor, "schedule.auto_disabled", idValue, {
        reason,
        capability: schedule.capabilitySlug,
        operatorAction: "Edit the schedule to target an enabled workflow, then enable it again."
      });
    }
    return { changed: Boolean(result.changes), schedule };
  }

  function autoDisableSchedulesForCapability(capabilitySlug, reason, actor = "system") {
    const schedules = listSchedules({ includeDisabled: false })
      .filter((schedule) => schedule.capabilitySlug === capabilitySlug);
    return schedules.map((schedule) => autoDisableSchedule(schedule.id, reason, actor));
  }

  function reconcileScheduleReferences(actor = "system") {
    const schedules = listSchedules({ includeDisabled: false });
    const results = [];
    for (const schedule of schedules) {
      const reason = scheduleReferenceProblem(schedule, getCapability);
      if (reason) results.push(autoDisableSchedule(schedule.id, reason, actor));
    }
    return results;
  }

  function reconcileRunTerminal(updatedRun) {
    if (!updatedRun || !RUN_TERMINAL.has(updatedRun.status)) return null;
    const row = one("SELECT * FROM schedules WHERE last_run_id = ?", [updatedRun.id]);
    const schedule = normalizeSchedule(row);
    if (!schedule || schedule.lastRunId !== updatedRun.id || schedule.lastStatus === updatedRun.status) {
      return schedule ? reconcileScheduleView(schedule) : null;
    }
    const query = scheduleRunTerminalUpdateQuery({
      scheduleId: schedule.id,
      runId: updatedRun.id,
      status: updatedRun.status,
      updatedAt: now()
    });
    run(query.sql, query.params);
    return getSchedule(schedule.id);
  }

  function reconcileScheduleLastRun(schedule) {
    if (!schedule?.lastRunId) return schedule;
    const linkedRun = one("SELECT id, status FROM runs WHERE id = ?", [schedule.lastRunId]);
    if (!linkedRun || !RUN_TERMINAL.has(linkedRun.status) || schedule.lastStatus === linkedRun.status) return schedule;
    const query = scheduleRunTerminalUpdateQuery({
      scheduleId: schedule.id,
      runId: schedule.lastRunId,
      status: linkedRun.status,
      updatedAt: now()
    });
    const result = run(query.sql, query.params);
    return result.changes ? { ...schedule, lastStatus: linkedRun.status, updatedAt: now() } : schedule;
  }

  function reconcileScheduleView(schedule) {
    if (!schedule) return schedule;
    const reason = scheduleReferenceProblem(schedule, getCapability);
    const state = schedule.enabled ? "enabled" : (schedule.disabledReason || reason) ? "broken" : "disabled";
    return {
      ...schedule,
      state,
      brokenReason: schedule.disabledReason || (reason && !schedule.enabled ? reason : ""),
      referenceStatus: reason ? { ok: false, reason } : { ok: true }
    };
  }

  return {
    autoDisableSchedule,
    autoDisableSchedulesForCapability,
    claimScheduleFire,
    createSchedule,
    deleteSchedule,
    getSchedule,
    listDueSchedules,
    listSchedules,
    recordScheduleFireResult,
    reconcileRunTerminal,
    reconcileScheduleReferences,
    setScheduleEnabled,
    updateSchedule
  };
}
