// Pure ordering / grouping helpers behind the #runs history view. Kept out of
// Home.jsx so the presentation contract is directly unit-testable.
//
// Operator-facing rule (see also runs-dashboard-ui.test.js):
//   Active work always leads. A completed run from today must never appear
//   above a running/queued/waiting run. Terminal runs group by day beneath
//   the "In flight" group, with day order controlled by the toolbar's
//   "Ended newest/oldest first" toggle. The toggle intentionally does NOT
//   flip active-first — an operator sorting history oldest-first still wants
//   to see live work at the top.
import { isActiveRun } from "./runHelpers.js";

export function runEndedAt(run) {
  if (isActiveRun(run)) return run?.startedAt || run?.createdAt || run?.updatedAt || "";
  return run?.completedAt || run?.updatedAt || run?.createdAt || "";
}

export function runChronologyMs(run) {
  const parsed = Date.parse(runEndedAt(run));
  if (Number.isFinite(parsed)) return parsed;
  const fallback = Date.parse(run?.createdAt || "");
  return Number.isFinite(fallback) ? fallback : 0;
}

export function compareRunsChronologically(a, b, order = "desc") {
  const direction = order === "asc" ? 1 : -1;
  const byEnded = (runChronologyMs(a) - runChronologyMs(b)) * direction;
  if (byEnded) return byEnded;
  const byCreated = (Date.parse(a?.createdAt || "") - Date.parse(b?.createdAt || "")) * direction;
  if (byCreated) return byCreated;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

export function dayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dayLabel(key, nowMs) {
  if (key === "active") return "In flight";
  if (key === "unknown") return "Unknown date";
  const today = dayKey(nowMs);
  const yesterday = dayKey(nowMs - 24 * 3600 * 1000);
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  const date = new Date(`${key}T12:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getUTCFullYear() === new Date(nowMs).getUTCFullYear() ? undefined : "numeric"
  });
}

export function groupRunsByEndedDate(runs, nowMs, order = "desc") {
  // Split active vs terminal FIRST so a completed run's timestamp can never
  // outrank an in-flight run for the top slot. Within each bucket we keep the
  // familiar chronological sort. Active is always newest-first regardless of
  // `order` — the toolbar toggle only reorders the history buckets below.
  const active = [];
  const terminal = [];
  for (const run of runs) {
    if (isActiveRun(run)) active.push(run);
    else terminal.push(run);
  }
  active.sort((a, b) => compareRunsChronologically(a, b, "desc"));
  terminal.sort((a, b) => compareRunsChronologically(a, b, order));

  const groups = [];
  if (active.length) {
    groups.push({ key: "active", label: dayLabel("active", nowMs), runs: active });
  }
  for (const run of terminal) {
    const key = dayKey(runEndedAt(run));
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(key, nowMs), runs: [] };
      groups.push(group);
    }
    group.runs.push(run);
  }
  return groups;
}
