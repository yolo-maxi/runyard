import { normalizeRun } from "./runRecords.js";
import {
  normalizeWorkItem,
  normalizeWorkItemEvent,
  normalizeWorkItemRunSummaryRows,
  workItemCreateRecord,
  workItemDeleteQuery,
  workItemEventInsertQuery,
  workItemEventListQuery,
  workItemEventRecord,
  workItemInsertQuery,
  workItemListQuery,
  workItemLookupQuery,
  workItemRunLinkQuery,
  workItemRunSummaryQuery,
  workItemRunsQuery,
  workItemUpdateQuery,
  workItemUpdateValues
} from "./workItemRecords.js";

export function createWorkItemStore({ all, one, run, id, now }) {
  function getWorkItem(idValue) {
    const query = workItemLookupQuery(idValue);
    return normalizeWorkItem(one(query.sql, query.params));
  }

  function addWorkItemEvent(workItemId, type, message = "", data = {}) {
    const record = workItemEventRecord({ id: id("wie"), workItemId, type, message, data, createdAt: now() });
    const query = workItemEventInsertQuery();
    run(query.sql, record);
    return normalizeWorkItemEvent({ ...record });
  }

  function createWorkItem(input) {
    const timestamp = now();
    const record = workItemCreateRecord({ id: id("wi"), input, timestamp });
    const query = workItemInsertQuery();
    run(query.sql, record);
    addWorkItemEvent(record.id, "work_item.created", `Created by ${record.created_by || "api"}`, {
      status: record.status,
      actor: record.created_by
    });
    return getWorkItem(record.id);
  }

  function listWorkItems(filters = {}) {
    const query = workItemListQuery(filters);
    return all(query.sql, query.params).map(normalizeWorkItem);
  }

  function updateWorkItem(idValue, updates = {}, { actor = "" } = {}) {
    const lookup = workItemLookupQuery(idValue);
    const existing = one(lookup.sql, lookup.params);
    if (!existing) return null;
    const timestamp = now();
    const query = workItemUpdateQuery({ idValue, values: workItemUpdateValues(existing, updates, timestamp) });
    run(query.sql, query.params);
    if (updates.status != null && updates.status !== existing.status) {
      addWorkItemEvent(idValue, "work_item.status_changed", `${existing.status} -> ${updates.status}`, {
        from: existing.status,
        to: updates.status,
        actor
      });
    } else {
      addWorkItemEvent(idValue, "work_item.updated", "Fields updated", {
        fields: Object.keys(updates),
        actor
      });
    }
    return getWorkItem(idValue);
  }

  function deleteWorkItem(idValue) {
    const existing = getWorkItem(idValue);
    if (!existing) return null;
    const query = workItemDeleteQuery(idValue);
    run(query.sql, query.params);
    return existing;
  }

  function listWorkItemEvents(workItemId, limit = 200) {
    const query = workItemEventListQuery(workItemId, limit);
    return all(query.sql, query.params).map(normalizeWorkItemEvent);
  }

  function listWorkItemRuns(workItemId) {
    const query = workItemRunsQuery(workItemId);
    return all(query.sql, query.params).map(normalizeRun);
  }

  // Link a run to a work item. Re-linking a run that already belongs to
  // another item moves it (the old item gets an unlink event) — a run only
  // ever works on one ticket at a time.
  function linkRunToWorkItem(workItemId, runId, { actor = "" } = {}) {
    const workItem = getWorkItem(workItemId);
    if (!workItem) return { ok: false, error: "work item not found", code: 404 };
    const runRow = one("SELECT id, work_item_id FROM runs WHERE id = ?", [runId]);
    if (!runRow) return { ok: false, error: "run not found", code: 404 };
    if (runRow.work_item_id === workItemId) return { ok: true, workItem, runId, idempotent: true };
    const query = workItemRunLinkQuery({ runId, workItemId, timestamp: now() });
    run(query.sql, query.params);
    if (runRow.work_item_id) {
      addWorkItemEvent(runRow.work_item_id, "work_item.run_unlinked", `Run ${runId} moved to ${workItemId}`, {
        runId,
        movedTo: workItemId,
        actor
      });
    }
    addWorkItemEvent(workItemId, "work_item.run_linked", `Run ${runId} linked`, { runId, actor });
    return { ok: true, workItem, runId };
  }

  function unlinkRunFromWorkItem(workItemId, runId, { actor = "" } = {}) {
    const workItem = getWorkItem(workItemId);
    if (!workItem) return { ok: false, error: "work item not found", code: 404 };
    const runRow = one("SELECT id, work_item_id FROM runs WHERE id = ?", [runId]);
    if (!runRow) return { ok: false, error: "run not found", code: 404 };
    if (runRow.work_item_id !== workItemId) {
      return { ok: false, error: "run is not linked to this work item", code: 409 };
    }
    const query = workItemRunLinkQuery({ runId, workItemId: null, timestamp: now() });
    run(query.sql, query.params);
    addWorkItemEvent(workItemId, "work_item.run_unlinked", `Run ${runId} unlinked`, { runId, actor });
    return { ok: true, workItem, runId };
  }

  // Per-item linked-run rollup ({total, byStatus, lastRunAt}) keyed by work
  // item id — one query decorates the whole board.
  function workItemRunSummaries() {
    const query = workItemRunSummaryQuery();
    return normalizeWorkItemRunSummaryRows(all(query.sql, query.params));
  }

  return {
    addWorkItemEvent,
    createWorkItem,
    deleteWorkItem,
    getWorkItem,
    linkRunToWorkItem,
    listWorkItemEvents,
    listWorkItemRuns,
    listWorkItems,
    unlinkRunFromWorkItem,
    updateWorkItem,
    workItemRunSummaries
  };
}
