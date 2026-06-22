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

const ALIASES = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *"
};

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELDS = [
  { key: "minute", min: 0, max: 59 },
  { key: "hour", min: 0, max: 23 },
  { key: "dom", min: 1, max: 31 },
  { key: "month", min: 1, max: 12, names: MONTH_NAMES },
  { key: "dow", min: 0, max: 7, names: DOW_NAMES }
];

// A few years is plenty to find the next occurrence of any valid expression
// (the rarest common case, Feb 29, repeats within 4 years). Past this we treat
// the expression as unsatisfiable from `from` and return null.
const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * 60 * 1000;

function fieldNumber(token, field) {
  const named = field.names ? field.names[token.toLowerCase()] : undefined;
  const raw = named != null ? named : Number(token);
  if (!Number.isInteger(raw)) {
    throw new Error(`invalid value "${token}" in ${field.key} field`);
  }
  // Normalize Sunday: cron allows 7 as well as 0.
  if (field.key === "dow" && raw === 7) return 0;
  if (raw < field.min || raw > field.max) {
    throw new Error(`value ${token} out of range (${field.min}-${field.max}) in ${field.key} field`);
  }
  return raw;
}

function addRange(set, from, to, step, field) {
  if (step <= 0) throw new Error(`invalid step in ${field.key} field`);
  if (from > to) throw new Error(`range start after end in ${field.key} field`);
  for (let value = from; value <= to; value += step) {
    set.add(field.key === "dow" && value === 7 ? 0 : value);
  }
}

function parseField(token, field) {
  const set = new Set();
  for (const part of String(token).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`empty term in ${field.key} field`);
    const [rangePart, stepPart] = trimmed.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (stepPart !== undefined && (!Number.isInteger(step) || step <= 0)) {
      throw new Error(`invalid step "${stepPart}" in ${field.key} field`);
    }
    if (rangePart === "*") {
      addRange(set, field.min, field.max, step, field);
      continue;
    }
    if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      addRange(set, fieldNumber(a, field), fieldNumber(b, field), step, field);
      continue;
    }
    const value = fieldNumber(rangePart, field);
    if (stepPart === undefined) {
      set.add(value);
    } else {
      // `a/n` means a, a+n, ... up to the field maximum.
      addRange(set, value, field.max, step, field);
    }
  }
  return set;
}

// Parse a cron expression into matcher sets. Throws on any malformed field so
// callers can surface a clear validation error. The returned object also tracks
// whether DOM/DOW were restricted, which drives standard Vixie-cron day logic
// (when both are restricted a day matches if EITHER matches).
export function parseCron(expression) {
  const raw = String(expression || "").trim();
  if (!raw) throw new Error("cron expression is empty");
  const normalized = raw.startsWith("@") ? ALIASES[raw.toLowerCase()] : raw;
  if (!normalized) throw new Error(`unknown cron alias "${raw}"`);
  const tokens = normalized.split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(`expected 5 cron fields, got ${tokens.length}`);
  }
  const spec = { source: raw };
  FIELDS.forEach((field, index) => {
    spec[field.key] = parseField(tokens[index], field);
  });
  spec.domRestricted = tokens[2] !== "*";
  spec.dowRestricted = tokens[4] !== "*";
  return spec;
}

export function isValidTimezone(tz) {
  if (!tz || tz === "UTC") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts (in `tz`) of an absolute instant.
function zonedParts(date, tz) {
  if (tz === "UTC") {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds()
    };
  }
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function tzOffsetMs(tz, atUtcMs) {
  if (tz === "UTC") return 0;
  const p = zonedParts(new Date(atUtcMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - atUtcMs;
}

// Convert a wall-clock time in `tz` to an absolute instant (ms). Uses the
// standard two-pass offset correction so DST transitions resolve sanely.
function zonedToInstant(year, month, day, hour, minute, second, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMs(tz, guess);
  let ts = guess - off1;
  const off2 = tzOffsetMs(tz, ts);
  if (off2 !== off1) ts = guess - off2;
  return ts;
}

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
  const spec = expression && typeof expression === "object" && spec_isParsed(expression)
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

function spec_isParsed(value) {
  return value.minute instanceof Set && value.dow instanceof Set;
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

const ORDINAL_DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL_MONTH = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Best-effort plain-language summary of common patterns. Falls back to echoing
// the normalized expression; the UI always pairs this with concrete next-run
// times, so an imperfect description is never the only signal.
export function describeCron(expression, tz = "UTC") {
  let tokens;
  try {
    const raw = String(expression || "").trim();
    const normalized = raw.startsWith("@") ? ALIASES[raw.toLowerCase()] : raw;
    parseCron(normalized); // validate
    tokens = normalized.split(/\s+/);
  } catch (error) {
    return `Invalid schedule (${error.message})`;
  }
  const [min, hour, dom, month, dow] = tokens;
  const tzSuffix = tz && tz !== "UTC" ? ` ${tz}` : " UTC";
  const at = (h, m) => `${pad2(Number(h))}:${pad2(Number(m))}${tzSuffix}`;
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyMin[1]} minutes`;
  }
  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (min === "0" && everyHour && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyHour[1]} hours`;
  }
  if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Hourly at :${pad2(Number(min))}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    if (dom === "*" && month === "*" && dow === "*") return `Daily at ${at(hour, min)}`;
    if (dom === "*" && month === "*" && /^\d+$/.test(dow)) {
      const day = ORDINAL_DOW[Number(dow) === 7 ? 0 : Number(dow)];
      return `Weekly on ${day} at ${at(hour, min)}`;
    }
    if (/^\d+$/.test(dom) && month === "*" && dow === "*") {
      return `Monthly on day ${Number(dom)} at ${at(hour, min)}`;
    }
    if (/^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
      return `Yearly on ${ORDINAL_MONTH[Number(month)]} ${Number(dom)} at ${at(hour, min)}`;
    }
  }
  return `Custom schedule (${tokens.join(" ")})${tzSuffix === " UTC" ? "" : ` in ${tz}`}`;
}
