// Work item (ticket) vocabulary shared by the board, detail, and editor.
// Mirrors src/workItemRecords.js — the server validates; this list only
// drives selects and lane grouping.

export const WORK_ITEM_STATUSES = [
  "intake",
  "triaged",
  "ready",
  "running",
  "waiting",
  "blocked",
  "review",
  "shipped",
  "accepted",
  "archived"
];

export const WORK_ITEM_TYPES = ["feature", "bug", "research", "release", "maintenance", "idea"];

export const WORK_ITEM_PRIORITIES = ["urgent", "high", "normal", "low"];

// Board lanes: group the ten statuses into seven columns that answer "what is
// where" at a glance. Archived is appended only when the operator asks.
export const BOARD_LANES = [
  { id: "intake", label: "Intake", statuses: ["intake"] },
  { id: "triaged", label: "Triaged", statuses: ["triaged"] },
  { id: "ready", label: "Ready", statuses: ["ready"] },
  { id: "running", label: "Running", statuses: ["running"] },
  { id: "attention", label: "Waiting / Blocked", statuses: ["waiting", "blocked"] },
  { id: "review", label: "Review", statuses: ["review"] },
  { id: "shipped", label: "Shipped", statuses: ["shipped", "accepted"] }
];

export const ARCHIVED_LANE = { id: "archived", label: "Archived", statuses: ["archived"] };

// Linked-run rollup one-liner, e.g. "3 runs · 1 running · 1 failed".
export function runRollupLabel(runs) {
  if (!runs || !runs.total) return "";
  const parts = [`${runs.total} run${runs.total === 1 ? "" : "s"}`];
  for (const [status, count] of Object.entries(runs.byStatus || {})) {
    if (status === "succeeded" && count === runs.total) continue;
    if (["running", "queued", "assigned", "waiting_approval", "paused", "failed", "budget_exceeded"].includes(status)) {
      parts.push(`${count} ${status.replace(/_/g, " ")}`);
    }
  }
  return parts.join(" · ");
}

// Flow step glyphs — one per src/runFlow.js FLOW_NODE_STATES entry.
export const FLOW_STATE_GLYPHS = {
  done: "✓",
  active: "▶",
  failed: "✗",
  waiting: "⏸",
  cancelled: "⊘",
  skipped: "»",
  pending: "○"
};
