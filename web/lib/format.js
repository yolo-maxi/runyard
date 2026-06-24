// Formatting helpers ported from legacy public/app.js. In React we don't need
// `esc()` for interpolation (JSX escapes), but the time/duration formatters are
// reused verbatim so the UI reads identically.

export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function runDurationMs(run, now = Date.now()) {
  if (run?.durationMs != null) return run.durationMs;
  if (!run?.createdAt) return null;
  const start = Date.parse(run.startedAt || run.createdAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60_000) return "in <1m";
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)}m`;
    if (ahead < 86_400_000) return `in ${Math.round(ahead / 3_600_000)}h`;
    return `in ${Math.round(ahead / 86_400_000)}d`;
  }
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function formatTimestamp(value) {
  if (!value) return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return String(value);
  return new Date(t).toLocaleString();
}
