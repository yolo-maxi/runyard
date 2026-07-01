import { redactText } from "./redaction.js";

const SECRET_FIELD_RE = /(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i;

export function redactContextValue(value, max = 240) {
  return redactText(value, { max, collapseWhitespace: true });
}

// Summarize run input for the model: a few human-meaningful keys, never any
// secret-shaped field, values redacted + truncated.
export function safeSupportInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const parts = [];
  for (const [key, raw] of Object.entries(input)) {
    if (key.startsWith("__")) continue;
    if (SECRET_FIELD_RE.test(key)) continue;
    if (raw == null || raw === "") continue;
    if (typeof raw === "object") continue;
    parts.push(`${key}=${redactContextValue(raw, 120)}`);
    if (parts.length >= 6) break;
  }
  return parts.join(", ");
}

// Parse the operator's route into {view, segments}. We trust the hash (it's the
// URL bar the operator literally sees) and fall back to the explicit view.
export function parseSupportRoute(context = {}) {
  const rawHash = String(context.hash || "").replace(/^#/, "");
  let segments = rawHash ? rawHash.split("/").filter(Boolean) : [];
  if (!segments.length && Array.isArray(context.segments)) {
    segments = context.segments.map((s) => String(s)).filter(Boolean);
  }
  let view = String((rawHash ? segments[0] : "") || context.view || segments[0] || "").toLowerCase();
  // Normalize the handful of aliases the router accepts.
  if (view === "dashboard" || view === "") view = "home";
  if (view === "capabilities") view = "workflows";
  return { view, segments, hash: rawHash };
}
