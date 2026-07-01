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
  scheduleUpdateQuery,
  scheduleUpdateValues
} from "./scheduleRecords.js";

export function createScheduleStore({ all, one, run, id, now }) {
  function getSchedule(idValue) {
    const query = scheduleLookupQuery(idValue);
    return normalizeSchedule(one(query.sql, query.params));
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
    return all(query.sql, query.params).map(normalizeSchedule);
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
    return all(query.sql, query.params).map(normalizeSchedule);
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

  return {
    claimScheduleFire,
    createSchedule,
    deleteSchedule,
    getSchedule,
    listDueSchedules,
    listSchedules,
    recordScheduleFireResult,
    setScheduleEnabled,
    updateSchedule
  };
}
