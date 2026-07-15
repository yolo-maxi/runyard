import { parseMaybeJson } from "./dbNormalization.js";

// The human-legible ticket lifecycle. There is deliberately no "failed"
// ticket state — the ticket is the durable ask, not one execution attempt.
// A failed linked run parks its ticket in blocked with an explicit reason
// (src/workItemRunSync.js); humans/agents can always re-park or retry.
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

export const WORK_ITEM_STATUS_DEFAULT = "intake";
export const WORK_ITEM_TYPE_DEFAULT = "feature";
export const WORK_ITEM_PRIORITY_DEFAULT = "normal";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function normalizeWorkItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    project: row.project || "",
    type: row.type || WORK_ITEM_TYPE_DEFAULT,
    status: row.status || WORK_ITEM_STATUS_DEFAULT,
    priority: row.priority || WORK_ITEM_PRIORITY_DEFAULT,
    owner: row.owner || "",
    requester: row.requester || "",
    acceptanceCriteria: row.acceptance_criteria || "",
    nextAction: row.next_action || "",
    blockedReason: row.blocked_reason || "",
    dueAt: row.due_at || null,
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function workItemCreateRecord({ id, input, timestamp }) {
  return {
    id,
    title: input.title,
    description: input.description || "",
    project: input.project || "",
    type: input.type || WORK_ITEM_TYPE_DEFAULT,
    status: input.status || WORK_ITEM_STATUS_DEFAULT,
    priority: input.priority || WORK_ITEM_PRIORITY_DEFAULT,
    owner: input.owner || "",
    requester: input.requester || "",
    acceptance_criteria: input.acceptanceCriteria || "",
    next_action: input.nextAction || "",
    blocked_reason: input.blockedReason || "",
    due_at: input.dueAt ? new Date(input.dueAt).toISOString() : null,
    created_by: input.createdBy || "",
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function workItemInsertQuery() {
  return {
    sql: `INSERT INTO work_items
     (id, title, description, project, type, status, priority, owner, requester,
      acceptance_criteria, next_action, blocked_reason, due_at, created_by, created_at, updated_at)
     VALUES ($id, $title, $description, $project, $type, $status, $priority, $owner, $requester,
      $acceptance_criteria, $next_action, $blocked_reason, $due_at, $created_by, $created_at, $updated_at)`
  };
}

export function workItemLookupQuery(idValue) {
  return {
    sql: "SELECT * FROM work_items WHERE id = ?",
    params: [idValue]
  };
}

export function workItemListQuery({
  status = "",
  project = "",
  owner = "",
  type = "",
  q = "",
  includeArchived = false,
  limit = 200
} = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  } else if (!includeArchived) {
    where.push("status <> 'archived'");
  }
  if (project) {
    where.push("project = ?");
    params.push(project);
  }
  if (owner) {
    where.push("owner = ?");
    params.push(owner);
  }
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  if (q) {
    // Plain substring match across the fields operators search by. Strip
    // wildcard characters so typing '%' or '_' cannot change search meaning.
    where.push("(title LIKE ? OR description LIKE ? OR project LIKE ? OR id LIKE ?)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    params.push(like, like, like, like);
  }
  return {
    sql: `SELECT * FROM work_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`,
    params: [...params, limit]
  };
}

const WORK_ITEM_UPDATE_FIELDS = [
  ["title", "title"],
  ["description", "description"],
  ["project", "project"],
  ["type", "type"],
  ["status", "status"],
  ["priority", "priority"],
  ["owner", "owner"],
  ["requester", "requester"],
  ["acceptanceCriteria", "acceptance_criteria"],
  ["nextAction", "next_action"],
  ["blockedReason", "blocked_reason"]
];

export function workItemUpdateValues(existing, updates = {}, timestamp) {
  const values = WORK_ITEM_UPDATE_FIELDS.map(([key, column]) =>
    updates[key] != null ? updates[key] : existing[column]
  );
  const dueAt = updates.dueAt !== undefined
    ? (updates.dueAt ? new Date(updates.dueAt).toISOString() : null)
    : existing.due_at;
  return [...values, dueAt, timestamp];
}

export function workItemUpdateQuery({ idValue, values }) {
  return {
    sql: `UPDATE work_items SET title=?, description=?, project=?, type=?, status=?, priority=?, owner=?, requester=?,
       acceptance_criteria=?, next_action=?, blocked_reason=?, due_at=?, updated_at=? WHERE id=?`,
    params: [...values, idValue]
  };
}

export function workItemDeleteQuery(idValue) {
  return {
    sql: "DELETE FROM work_items WHERE id = ?",
    params: [idValue]
  };
}

// --- Ticket history (mirrors run_events) -------------------------------------

export function workItemEventRecord({ id, workItemId, type, message = "", data = {}, createdAt }) {
  return {
    id,
    work_item_id: workItemId,
    type,
    message,
    data: jsonField(data, {}),
    created_at: createdAt
  };
}

export function workItemEventInsertQuery() {
  return {
    sql: "INSERT INTO work_item_events (id, work_item_id, type, message, data, created_at) VALUES ($id, $work_item_id, $type, $message, $data, $created_at)"
  };
}

export function workItemEventListQuery(workItemId, limit = 200) {
  return {
    sql: "SELECT * FROM work_item_events WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    params: [workItemId, limit]
  };
}

export function normalizeWorkItemEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    type: row.type,
    message: row.message,
    data: parseMaybeJson(row.data, {}),
    createdAt: row.created_at
  };
}

// --- Run linkage --------------------------------------------------------------

export function workItemRunsQuery(workItemId) {
  return {
    sql: "SELECT * FROM runs WHERE work_item_id = ? ORDER BY created_at DESC",
    params: [workItemId]
  };
}

export function workItemRunLinkQuery({ runId, workItemId, timestamp }) {
  return {
    sql: "UPDATE runs SET work_item_id = ?, updated_at = ? WHERE id = ?",
    params: [workItemId, timestamp, runId]
  };
}

// One row per (work item, run status) across all linked runs — the board
// decorates every card from a single query instead of N per-item scans.
export function workItemRunSummaryQuery() {
  return {
    sql: `SELECT work_item_id, status, COUNT(*) AS count, MAX(created_at) AS last_created_at
       FROM runs
      WHERE work_item_id IS NOT NULL
      GROUP BY work_item_id, status`,
    params: []
  };
}

export function normalizeWorkItemRunSummaryRows(rows = []) {
  const byItem = new Map();
  for (const row of rows) {
    const entry = byItem.get(row.work_item_id) || { total: 0, byStatus: {}, lastRunAt: null };
    entry.total += Number(row.count) || 0;
    entry.byStatus[row.status] = Number(row.count) || 0;
    if (!entry.lastRunAt || String(row.last_created_at) > entry.lastRunAt) {
      entry.lastRunAt = row.last_created_at;
    }
    byItem.set(row.work_item_id, entry);
  }
  return byItem;
}
