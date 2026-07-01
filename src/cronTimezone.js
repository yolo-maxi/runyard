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
export function zonedParts(date, tz) {
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
export function zonedToInstant(year, month, day, hour, minute, second, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = tzOffsetMs(tz, guess);
  let ts = guess - off1;
  const off2 = tzOffsetMs(tz, ts);
  if (off2 !== off1) ts = guess - off2;
  return ts;
}
