// Tiny, dependency-free standard 5-field cron parser + next-run calculator.
//
// Fields (in order): minute hour day-of-month month day-of-week
// Supported syntax per field:
//   *            any value
//   a            a single value
//   a-b          an inclusive range
//   a,b,c        a list (each item may itself be a range/step)
//   */n          every n starting from the field minimum
//   a-b/n        every n within the range
//   a/n          every n from a to the field maximum
// Month names (jan..dec) and weekday names (sun..sat) are accepted
// case-insensitively. Day-of-week accepts both 0 and 7 for Sunday.
//
// Convenience aliases: @yearly/@annually, @monthly, @weekly, @daily/@midnight,
// @hourly.
//
// Timezone: nextRun() evaluates the schedule against wall-clock time in the
// given IANA timezone (default "UTC") using Intl, so DST shifts are honored.
// We deliberately do NOT support a seconds field — minute granularity matches
// the Hub's ticker and keeps the surface small and well-tested.

import {
  isParsedCronSpec,
  parseCron
} from "./cronParser.js";
import {
  isValidTimezone,
  zonedParts,
  zonedToInstant
} from "./cronTimezone.js";

export { parseCron } from "./cronParser.js";
export { describeCron } from "./cronDescription.js";
export { isValidTimezone } from "./cronTimezone.js";

// A few years is plenty to find the next occurrence of any valid expression
// (the rarest common case, Feb 29, repeats within 4 years). Past this we treat
// the expression as unsatisfiable from `from` and return null.
const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * 60 * 1000;

function dayMatches(spec, day, weekday) {
  const domOk = spec.dom.has(day);
  const dowOk = spec.dow.has(weekday);
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

// The next instant strictly after `from` at which `expression` fires in `tz`.
// Returns a Date, or null if no occurrence within the search horizon.
//
// We walk wall-clock minutes as if they were UTC (so calendar math is trivial
// and DST-agnostic), then convert the matched wall-clock back to a real instant
// in `tz` for the return value.
export function nextRun(expression, from = new Date(), tz = "UTC") {
  const spec = expression && typeof expression === "object" && isParsedCronSpec(expression)
    ? expression
    : parseCron(expression);
  if (!isValidTimezone(tz)) throw new Error(`invalid timezone "${tz}"`);
  const zone = tz || "UTC";
  const start = zonedParts(from instanceof Date ? from : new Date(from), zone);
  // Drop seconds and advance one minute so we never return `from` itself.
  let cursor = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute) + 60_000;
  const limit = cursor + SEARCH_LIMIT_MS;
  while (cursor <= limit) {
    const d = new Date(cursor);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    const weekday = d.getUTCDay();
    if (!spec.month.has(month)) {
      cursor = Date.UTC(year, month, 1); // first day of next month, 00:00
      continue;
    }
    if (!dayMatches(spec, day, weekday)) {
      cursor = Date.UTC(year, month - 1, day + 1); // next day, 00:00
      continue;
    }
    if (!spec.hour.has(hour)) {
      cursor = Date.UTC(year, month - 1, day, hour + 1); // next hour, :00
      continue;
    }
    if (!spec.minute.has(minute)) {
      cursor += 60_000;
      continue;
    }
    return new Date(zonedToInstant(year, month, day, hour, minute, 0, zone));
  }
  return null;
}

// The next `count` fire instants after `from` (ISO strings). Used by the
// schedule preview endpoint so the UI can show a human-checkable forecast.
export function nextRuns(expression, count = 3, from = new Date(), tz = "UTC") {
  const spec = parseCron(expression);
  const out = [];
  let cursor = from instanceof Date ? from : new Date(from);
  for (let i = 0; i < count; i += 1) {
    const next = nextRun(spec, cursor, tz);
    if (!next) break;
    out.push(next.toISOString());
    cursor = next;
  }
  return out;
}

// Validate without throwing. Returns { ok, error } so HTTP routes can return a
// clean 400 with the reason.
export function validateCron(expression, tz = "UTC") {
  try {
    parseCron(expression);
    if (!isValidTimezone(tz)) return { ok: false, error: `invalid timezone "${tz}"` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
