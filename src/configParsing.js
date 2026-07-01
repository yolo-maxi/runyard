import path from "node:path";

export function parseBool(value, fallback = true) {
  if (value == null || value === "") return fallback;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

export function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseRootList(value, { resolve = path.resolve } = {}) {
  return String(value || "")
    .split(/[:,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

export function parseTrustProxy(value, fallback = "loopback") {
  if (value == null || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
