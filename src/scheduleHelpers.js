import { describeCron, isValidTimezone, nextRuns, validateCron } from "./cron.js";
import { now } from "./ids.js";

export const SCHEDULE_NAME_MAX = 120;
export const SCHEDULE_INPUT_MAX_BYTES = 16 * 1024;

export function validateScheduleBody(body = {}, { partial = false, getCapability } = {}) {
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  if (!partial || has("name")) {
    const name = String(body.name || "").trim();
    if (!name) return { ok: false, error: "name is required" };
    if (name.length > SCHEDULE_NAME_MAX) return { ok: false, error: `name must be <= ${SCHEDULE_NAME_MAX} characters` };
    out.name = name;
  }
  if (has("description")) out.description = String(body.description || "").slice(0, 2000);

  if (!partial || has("capabilitySlug") || has("capability")) {
    const slug = String(body.capabilitySlug || body.capability || "").trim();
    if (!slug) return { ok: false, error: "capabilitySlug is required" };
    const capability = getCapability?.(slug);
    if (!capability || !capability.enabled) return { ok: false, error: `unknown or disabled capability "${slug}"` };
    out.capabilitySlug = capability.slug;
  }

  let timezone = "UTC";
  if (has("timezone")) {
    timezone = String(body.timezone || "UTC").trim() || "UTC";
    if (!isValidTimezone(timezone)) return { ok: false, error: `invalid timezone "${timezone}"` };
    out.timezone = timezone;
  }

  if (has("cron")) {
    const cron = String(body.cron || "").trim();
    if (cron) {
      const check = validateCron(cron, out.timezone || timezone);
      if (!check.ok) return { ok: false, error: `invalid cron expression: ${check.error}` };
    }
    out.cron = cron;
  }
  if (has("runAt")) {
    if (body.runAt) {
      const when = new Date(body.runAt);
      if (Number.isNaN(when.getTime())) return { ok: false, error: "runAt is not a valid date" };
      out.runAt = when.toISOString();
    } else {
      out.runAt = null;
    }
  }

  if (!partial) {
    const cron = out.cron || "";
    const runAt = out.runAt || null;
    if (!cron && !runAt) return { ok: false, error: "a cron expression or a runAt time is required" };
    if (runAt && !cron && runAt <= now()) return { ok: false, error: "runAt must be in the future" };
  }

  if (has("input")) {
    const input = body.input;
    if (input != null && (typeof input !== "object" || Array.isArray(input))) {
      return { ok: false, error: "input must be a JSON object" };
    }
    const obj = input || {};
    if (Buffer.byteLength(JSON.stringify(obj), "utf8") > SCHEDULE_INPUT_MAX_BYTES) {
      return { ok: false, error: "input payload too large" };
    }
    out.input = obj;
  } else if (!partial) {
    out.input = {};
  }

  if (has("enabled")) {
    out.enabled = !(body.enabled === false || body.enabled === "false" || body.enabled === 0);
  }

  return { ok: true, value: out };
}

export function schedulePreview(cron, timezone = "UTC", count = 5, from = new Date()) {
  const expression = String(cron || "").trim();
  const tz = String(timezone || "UTC").trim() || "UTC";
  if (!expression) return { ok: false, status: 400, error: "cron query parameter is required" };
  if (!isValidTimezone(tz)) return { ok: false, status: 400, error: `invalid timezone "${tz}"` };
  const check = validateCron(expression, tz);
  if (!check.ok) return { ok: true, value: { valid: false, error: check.error } };
  return {
    ok: true,
    value: {
      valid: true,
      timezone: tz,
      description: describeCron(expression, tz),
      nextRuns: nextRuns(expression, count, from, tz)
    }
  };
}

export function withScheduleView(schedule, { from = new Date() } = {}) {
  if (!schedule) return schedule;
  let preview = null;
  if (schedule.cron) {
    try {
      preview = {
        description: describeCron(schedule.cron, schedule.timezone),
        nextRuns: nextRuns(schedule.cron, 3, from, schedule.timezone)
      };
    } catch {
      preview = null;
    }
  } else if (schedule.runAt) {
    preview = {
      description: `Once at ${schedule.runAt}`,
      nextRuns: schedule.enabled && schedule.nextRunAt ? [schedule.nextRunAt] : []
    };
  }
  return { ...schedule, preview, deepLink: `/app#schedules/${encodeURIComponent(schedule.id)}` };
}
