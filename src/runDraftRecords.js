import { parseMaybeJson } from "./dbNormalization.js";
import {
  RUN_PREFLIGHT_BLOCKED,
  RUN_PREFLIGHT_NEEDS_INPUT,
  RUN_PREFLIGHT_READY
} from "./runPreflight.js";

// Draft lifecycle: a draft stays in one of the open (negotiation) statuses —
// which mirror preflight statuses exactly — until it is either submitted
// (a real run was enqueued; run_id records which) or discarded.
export const RUN_DRAFT_OPEN_STATUSES = Object.freeze([
  RUN_PREFLIGHT_READY,
  RUN_PREFLIGHT_NEEDS_INPUT,
  RUN_PREFLIGHT_BLOCKED
]);
export const RUN_DRAFT_SUBMITTED = "submitted";
export const RUN_DRAFT_DISCARDED = "discarded";

export function runDraftIsOpen(draft) {
  return Boolean(draft) && RUN_DRAFT_OPEN_STATUSES.includes(draft.status);
}

export function normalizeRunDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    capabilitySlug: row.capability_slug,
    input: parseMaybeJson(row.input, {}),
    options: parseMaybeJson(row.options, {}),
    status: row.status,
    preflight: parseMaybeJson(row.preflight, {}),
    createdBy: row.created_by || "",
    runId: row.run_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Shallow negotiation merge for PATCHed draft input: patch keys overwrite,
// explicit nulls delete. This is how a client answers questions[] one at a
// time without resending the whole input.
export function mergeRunDraftInput(existing = {}, patch = {}) {
  const merged = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const [key, value] of Object.entries(patch && typeof patch === "object" ? patch : {})) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function runDraftInsertQuery() {
  return {
    sql: `INSERT INTO run_drafts (id, capability_slug, input, options, status, preflight, created_by, run_id, created_at, updated_at)
     VALUES ($id, $capability_slug, $input, $options, $status, $preflight, $created_by, $run_id, $created_at, $updated_at)`
  };
}

export function runDraftUpdateQuery() {
  return {
    sql: `UPDATE run_drafts SET input=$input, options=$options, status=$status, preflight=$preflight, run_id=$run_id, updated_at=$updated_at
     WHERE id=$id`
  };
}

export function runDraftLookupQuery(draftId) {
  return { sql: "SELECT * FROM run_drafts WHERE id = ?", params: [draftId] };
}

export function runDraftListQuery({ status = "", capability = "", limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (capability) {
    where.push("capability_slug = ?");
    params.push(capability);
  }
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return {
    sql: `SELECT * FROM run_drafts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    params
  };
}
