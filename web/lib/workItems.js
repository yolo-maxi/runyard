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
  {
    id: "intake",
    label: "Needs triage",
    hint: "New requests that need scope, owner, or priority.",
    empty: "No untriaged asks.",
    statuses: ["intake"]
  },
  {
    id: "triaged",
    label: "Plan next",
    hint: "Known work that still needs the next concrete action.",
    empty: "Nothing waiting for planning.",
    statuses: ["triaged"]
  },
  {
    id: "ready",
    label: "Ready to start",
    hint: "Work that can be launched or assigned now.",
    empty: "No launch-ready work.",
    statuses: ["ready"]
  },
  {
    id: "running",
    label: "In motion",
    hint: "Work with an active run or ongoing owner action.",
    empty: "Nothing currently moving.",
    statuses: ["running"]
  },
  {
    id: "attention",
    label: "Needs decision",
    hint: "Waiting, blocked, paused, failed, or approval-heavy work.",
    empty: "No blockers or human decisions.",
    statuses: ["waiting", "blocked"]
  },
  {
    id: "review",
    label: "Review / approve",
    hint: "Done enough to inspect, merge, accept, or send back.",
    empty: "Nothing awaiting review.",
    statuses: ["review"]
  },
  {
    id: "shipped",
    label: "Done",
    hint: "Shipped or accepted work that can be archived later.",
    empty: "No completed work on this board.",
    statuses: ["shipped", "accepted"]
  }
];

export const ARCHIVED_LANE = {
  id: "archived",
  label: "Archived",
  hint: "Finished history hidden from the default board.",
  empty: "No archived work items.",
  statuses: ["archived"]
};

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

export function workItemAction(item) {
  const attention = Number(item?.runs?.attention || 0);
  if (item?.status === "blocked") {
    return {
      tone: "danger",
      label: "Unblock",
      detail: item.blockedReason || item.nextAction || "Decide what is blocking this work."
    };
  }
  if (attention > 0) {
    return {
      tone: "warn",
      label: "Needs human",
      detail: `${attention} linked run${attention === 1 ? "" : "s"} need attention.`
    };
  }
  if (item?.status === "waiting") {
    return {
      tone: "warn",
      label: "Waiting",
      detail: item.nextAction || "Check what external input or retry is needed."
    };
  }
  if (item?.status === "review") {
    return {
      tone: "info",
      label: "Review",
      detail: item.nextAction || "Inspect the result and accept, ship, or send back."
    };
  }
  if (item?.status === "intake") {
    return {
      tone: "neutral",
      label: "Triage",
      detail: item.nextAction || "Add owner, priority, acceptance criteria, and next action."
    };
  }
  if (item?.status === "triaged") {
    return {
      tone: "neutral",
      label: "Plan",
      detail: item.nextAction || "Choose the workflow or next owner action."
    };
  }
  if (item?.status === "ready") {
    return {
      tone: "success",
      label: "Launch",
      detail: item.nextAction || "Start or assign the next run."
    };
  }
  if (item?.status === "running") {
    return {
      tone: "info",
      label: "Monitor",
      detail: item.nextAction || runRollupLabel(item.runs) || "Watch the active work."
    };
  }
  if (item?.status === "shipped") {
    return {
      tone: "success",
      label: "Accept",
      detail: item.nextAction || "Final-check and move to accepted or archived."
    };
  }
  if (item?.status === "accepted") {
    return {
      tone: "success",
      label: "Archive",
      detail: item.nextAction || "Archive when no longer useful on the active board."
    };
  }
  return {
    tone: "neutral",
    label: "Next",
    detail: item?.nextAction || "Open the item and decide the next step."
  };
}

export function isOperatorAttention(item) {
  return Boolean(
    item?.status === "blocked" ||
    item?.status === "waiting" ||
    item?.status === "review" ||
    item?.status === "intake" ||
    item?.priority === "urgent" ||
    Number(item?.runs?.attention || 0) > 0
  );
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
