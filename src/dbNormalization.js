export function parseMaybeJson(value, fallback) {
  if (typeof value !== "string") return value ?? fallback;
  if (value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// A positive integer number of minutes, or null (use the global default).
export function normalizeMaxRunMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}
