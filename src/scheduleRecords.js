import { nextRun as cronNextRun } from "./cron.js";
import { parseMaybeJson } from "./dbNormalization.js";
import { now } from "./ids.js";

export const SCHEDULE_TIMEZONE_DEFAULT = "UTC";

export function normalizeSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    capabilitySlug: row.capability_slug,
    cron: row.cron || "",
    timezone: row.timezone || SCHEDULE_TIMEZONE_DEFAULT,
    input: parseMaybeJson(row.input, {}),
    enabled: Boolean(row.enabled),
    kind: row.cron ? "cron" : "once",
    runAt: row.run_at || null,
    nextRunAt: row.next_run_at || null,
    lastRunAt: row.last_run_at || null,
    lastRunId: row.last_run_id || null,
    lastStatus: row.last_status || "",
    disabledReason: row.disabled_reason || "",
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Next fire instant (ISO) for a schedule definition. Cron schedules use the
// expression; one-shot schedules use run_at while it is still in the future.
// Returns null when there is nothing further to fire.
export function computeScheduleNext(def, fromIso = now()) {
  if (def.cron) {
    const next = cronNextRun(def.cron, new Date(fromIso), def.timezone || SCHEDULE_TIMEZONE_DEFAULT);
    return next ? next.toISOString() : null;
  }
  if (def.runAt) return def.runAt > fromIso ? def.runAt : null;
  return null;
}

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function scheduleCreateRecord({ id, input, timestamp }) {
  const cron = String(input.cron || "").trim();
  const runAt = input.runAt ? new Date(input.runAt).toISOString() : null;
  const timezone = input.timezone || SCHEDULE_TIMEZONE_DEFAULT;
  const enabled = input.enabled === false ? 0 : 1;
  const nextRunAt = enabled ? computeScheduleNext({ cron, runAt, timezone }, timestamp) : null;
  return {
    id,
    name: input.name,
    description: input.description || "",
    capability_slug: input.capabilitySlug,
    cron,
    timezone,
    input: jsonField(input.input || {}, {}),
    enabled,
    run_at: runAt,
    next_run_at: nextRunAt,
    last_run_at: null,
    last_run_id: null,
    last_status: "",
    disabled_reason: "",
    created_by: input.createdBy || "",
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function scheduleInsertQuery() {
  return {
    sql: `INSERT INTO schedules
     (id, name, description, capability_slug, cron, timezone, input, enabled, run_at, next_run_at,
      last_run_at, last_run_id, last_status, disabled_reason, created_by, created_at, updated_at)
     VALUES ($id, $name, $description, $capability_slug, $cron, $timezone, $input, $enabled, $run_at, $next_run_at,
      $last_run_at, $last_run_id, $last_status, $disabled_reason, $created_by, $created_at, $updated_at)`
  };
}

export function scheduleLookupQuery(idValue) {
  return {
    sql: "SELECT * FROM schedules WHERE id = ?",
    params: [idValue]
  };
}

export function scheduleListQuery({ includeDisabled = true } = {}) {
  return includeDisabled
    ? {
        sql: "SELECT * FROM schedules ORDER BY created_at DESC",
        params: []
      }
    : {
        sql: "SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at DESC",
        params: []
      };
}

export function scheduleUpdateValues(existing, updates = {}, timestamp = now()) {
  const merged = {
    name: updates.name != null ? updates.name : existing.name,
    description: updates.description != null ? updates.description : existing.description,
    capability_slug: updates.capabilitySlug != null ? updates.capabilitySlug : existing.capability_slug,
    cron: updates.cron != null ? String(updates.cron).trim() : existing.cron,
    timezone: updates.timezone != null ? updates.timezone : existing.timezone,
    input: updates.input !== undefined ? jsonField(updates.input || {}, {}) : existing.input,
    enabled: updates.enabled == null ? existing.enabled : updates.enabled === false ? 0 : 1,
    run_at: updates.runAt !== undefined ? (updates.runAt ? new Date(updates.runAt).toISOString() : null) : existing.run_at
  };
  const nextRunAt = merged.enabled
    ? computeScheduleNext({ cron: merged.cron, runAt: merged.run_at, timezone: merged.timezone }, timestamp)
    : null;
  return [
    merged.name,
    merged.description,
    merged.capability_slug,
    merged.cron,
    merged.timezone,
    merged.input,
    merged.enabled,
    merged.run_at,
    nextRunAt,
    timestamp
  ];
}

export function scheduleUpdateQuery({ idValue, values }) {
  return {
    sql: `UPDATE schedules SET name=?, description=?, capability_slug=?, cron=?, timezone=?, input=?, enabled=?,
       run_at=?, next_run_at=?, disabled_reason='', updated_at=? WHERE id=?`,
    params: [...values, idValue]
  };
}

export function scheduleDeleteQuery(idValue) {
  return {
    sql: "DELETE FROM schedules WHERE id = ?",
    params: [idValue]
  };
}

export function dueSchedulesQuery(nowIso) {
  return {
    sql: "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
    params: [nowIso]
  };
}

export function scheduleClaimDecision(row, expectedNextRunAt, nowIso = now()) {
  if (!row) return { ok: false, reason: "not_found" };
  if (!row.enabled) return { ok: false, reason: "disabled" };
  if (row.next_run_at !== expectedNextRunAt) return { ok: false, reason: "raced" };
  const oneShot = !row.cron;
  return {
    ok: true,
    nextRunAt: oneShot ? null : computeScheduleNext({ cron: row.cron, runAt: row.run_at, timezone: row.timezone }, nowIso),
    enabled: oneShot ? 0 : 1
  };
}

export function scheduleClaimUpdateQuery({ idValue, expectedNextRunAt, decision, nowIso }) {
  return {
    sql: "UPDATE schedules SET next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ? AND next_run_at = ? AND enabled = 1",
    params: [decision.nextRunAt, decision.enabled, nowIso, idValue, expectedNextRunAt]
  };
}

export function scheduleFireResultUpdateQuery({ idValue, runId, status, firedAtIso, updatedAt }) {
  return {
    sql: "UPDATE schedules SET last_run_at = ?, last_run_id = ?, last_status = ?, updated_at = ? WHERE id = ?",
    params: [firedAtIso, runId || null, status, updatedAt, idValue]
  };
}

export function scheduleRunTerminalUpdateQuery({ scheduleId, runId, status, updatedAt }) {
  return {
    sql: "UPDATE schedules SET last_status = ?, updated_at = ? WHERE id = ? AND last_run_id = ?",
    params: [status, updatedAt, scheduleId, runId]
  };
}

export function scheduleAutoDisableQuery({ idValue, reason, status, updatedAt }) {
  return {
    sql: "UPDATE schedules SET enabled = 0, next_run_at = NULL, last_status = ?, disabled_reason = ?, updated_at = ? WHERE id = ? AND (enabled = 1 OR disabled_reason = '')",
    params: [status, reason, updatedAt, idValue]
  };
}
