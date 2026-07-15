import { deepLinks } from "./deepLinks.js";
import {
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TYPES
} from "./workItemRecords.js";

const TEXT_FIELDS = [
  ["title", 200],
  ["description", 4000],
  ["project", 120],
  ["owner", 120],
  ["requester", 120],
  ["acceptanceCriteria", 4000],
  ["nextAction", 500],
  ["blockedReason", 500]
];

const ENUM_FIELDS = [
  ["status", WORK_ITEM_STATUSES],
  ["type", WORK_ITEM_TYPES],
  ["priority", WORK_ITEM_PRIORITIES]
];

// Validate a create (partial: false) or PATCH (partial: true) body into the
// camelCase shape the store accepts. Returns {ok, value} or {ok:false, error}.
export function validateWorkItemBody(body = {}, { partial = false } = {}) {
  const value = {};
  for (const [field, max] of TEXT_FIELDS) {
    if (body[field] === undefined) continue;
    if (body[field] !== null && typeof body[field] !== "string") {
      return { ok: false, error: `${field} must be a string` };
    }
    const text = String(body[field] ?? "").trim();
    if (text.length > max) return { ok: false, error: `${field} must be at most ${max} characters` };
    value[field] = text;
  }
  if (!partial && !value.title) return { ok: false, error: "title is required" };
  if (partial && body.title !== undefined && !value.title) {
    return { ok: false, error: "title cannot be cleared" };
  }
  for (const [field, allowed] of ENUM_FIELDS) {
    if (body[field] === undefined) continue;
    const candidate = String(body[field] || "").trim();
    if (!allowed.includes(candidate)) {
      return { ok: false, error: `${field} must be one of: ${allowed.join(", ")}` };
    }
    value[field] = candidate;
  }
  if (body.dueAt !== undefined) {
    if (body.dueAt === null || body.dueAt === "") {
      value.dueAt = null;
    } else {
      const parsed = new Date(body.dueAt);
      if (Number.isNaN(parsed.getTime())) return { ok: false, error: "dueAt must be a valid date" };
      value.dueAt = parsed.toISOString();
    }
  }
  return { ok: true, value };
}

// Linked-run statuses that mean a human action is pending somewhere under
// this ticket — the same triage signal GET /api/runs/attention uses.
const ATTENTION_RUN_STATUSES = ["paused", "waiting_approval", "budget_exceeded"];

export function workItemRunRollup(summary) {
  if (!summary) return { total: 0, byStatus: {}, lastRunAt: null, attention: 0 };
  const attention = ATTENTION_RUN_STATUSES.reduce(
    (sum, status) => sum + (summary.byStatus?.[status] || 0),
    0
  );
  return { total: summary.total, byStatus: summary.byStatus, lastRunAt: summary.lastRunAt, attention };
}

export function withWorkItemView(workItem, runSummary = undefined) {
  if (!workItem || typeof workItem !== "object") return workItem;
  return {
    ...workItem,
    ...(runSummary !== undefined ? { runs: workItemRunRollup(runSummary) } : {}),
    deepLink: deepLinks.workItem(workItem.id),
    deepLinkFlow: deepLinks.workItemFlow(workItem.id)
  };
}
