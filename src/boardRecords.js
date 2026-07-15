import { parseMaybeJson } from "./dbNormalization.js";
import { WORK_ITEM_STATUSES } from "./workItemRecords.js";

// Boards: durable, configurable views over the work-items table — the
// "software factory" surfaces. A board owns its lane definitions (operator
// language over lifecycle statuses), an optional project scope, and the
// workflow slugs it suggests launching from tickets. One board is seeded as
// the instance default (see boardStore.ensureDefaultBoard); more can be
// created for product/infra/docs/release trains later.

// The default lane set: seven columns in operator language over the ten
// lifecycle statuses. This is the single server-side source; the web app
// keeps a copy only as an offline fallback (web/lib/workItems.js).
export const BOARD_LANE_TRIGGER_MODES = ["none", "suggest", "confirm", "auto"];

export const DEFAULT_BOARD_LANES = [
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
    statuses: ["ready"],
    trigger: {
      mode: "suggest",
      label: "Ready to launch",
      workflow: "runyard-smoke-check",
      description: "Surface the default workflow launcher without enqueueing anything."
    }
  },
  {
    id: "running",
    label: "In motion",
    hint: "Work with an active run or ongoing owner action.",
    empty: "Nothing currently moving.",
    statuses: ["running"],
    trigger: {
      mode: "confirm",
      label: "Launch linked run",
      workflow: "runyard-smoke-check",
      description: "Confirm before enqueueing the lane workflow and linking it to the ticket."
    }
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

export function normalizeBoard(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description || "",
    project: row.project || "",
    lanes: parseMaybeJson(row.lanes, []),
    defaultWorkflows: parseMaybeJson(row.default_workflows, []),
    isDefault: Boolean(row.is_default),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function boardCreateRecord({ id, input, timestamp }) {
  return {
    id,
    slug: input.slug,
    title: input.title,
    description: input.description || "",
    project: input.project || "",
    lanes: JSON.stringify(input.lanes && input.lanes.length ? input.lanes : DEFAULT_BOARD_LANES),
    default_workflows: JSON.stringify(input.defaultWorkflows || []),
    is_default: input.isDefault ? 1 : 0,
    created_by: input.createdBy || "",
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function boardInsertQuery() {
  return {
    sql: `INSERT INTO boards
     (id, slug, title, description, project, lanes, default_workflows, is_default, created_by, created_at, updated_at)
     VALUES ($id, $slug, $title, $description, $project, $lanes, $default_workflows, $is_default, $created_by, $created_at, $updated_at)`
  };
}

export function boardListQuery() {
  return { sql: "SELECT * FROM boards ORDER BY is_default DESC, title ASC", params: [] };
}

export function boardLookupQuery(slugOrId) {
  return { sql: "SELECT * FROM boards WHERE slug = ? OR id = ?", params: [slugOrId, slugOrId] };
}

export function boardCountQuery() {
  return { sql: "SELECT COUNT(*) AS count FROM boards", params: [] };
}

// Partial update: only provided fields change; lanes/defaultWorkflows are
// stored as JSON.
export function boardUpdateValues(existing, updates, timestamp) {
  return {
    title: updates.title != null ? updates.title : existing.title,
    description: updates.description != null ? updates.description : existing.description,
    project: updates.project != null ? updates.project : existing.project,
    lanes: updates.lanes != null ? JSON.stringify(updates.lanes) : existing.lanes,
    default_workflows: updates.defaultWorkflows != null ? JSON.stringify(updates.defaultWorkflows) : existing.default_workflows,
    is_default: updates.isDefault != null ? (updates.isDefault ? 1 : 0) : existing.is_default,
    updated_at: timestamp
  };
}

export function boardUpdateQuery({ idValue, values }) {
  return {
    sql: `UPDATE boards SET title = $title, description = $description, project = $project,
      lanes = $lanes, default_workflows = $default_workflows, is_default = $is_default,
      updated_at = $updated_at WHERE slug = $slug_or_id OR id = $slug_or_id`,
    params: { ...values, slug_or_id: idValue }
  };
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Validation for create (partial=false) and update (partial=true) bodies.
// Lanes must be an array of {id, label, statuses[]} whose statuses are real
// lifecycle statuses — a board that references unknown statuses would
// silently hide tickets.
export function validateBoardBody(body = {}, { partial = false } = {}) {
  const value = {};
  if (body.slug !== undefined || !partial) {
    const slug = String(body.slug || "").trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) return { ok: false, error: "slug must be lowercase letters/digits/hyphens (max 64 chars)" };
    value.slug = slug;
  }
  if (body.title !== undefined || !partial) {
    const title = String(body.title || "").trim();
    if (!title) return { ok: false, error: "title is required" };
    if (title.length > 120) return { ok: false, error: "title is too long (max 120 chars)" };
    value.title = title;
  }
  if (body.description !== undefined) value.description = String(body.description || "").slice(0, 2000);
  if (body.project !== undefined) value.project = String(body.project || "").trim().slice(0, 120);
  if (body.defaultWorkflows !== undefined) {
    if (!Array.isArray(body.defaultWorkflows) || body.defaultWorkflows.some((slug) => typeof slug !== "string" || !slug.trim())) {
      return { ok: false, error: "defaultWorkflows must be an array of workflow slugs" };
    }
    value.defaultWorkflows = body.defaultWorkflows.map((slug) => slug.trim());
  }
  if (body.isDefault !== undefined) value.isDefault = Boolean(body.isDefault);
  if (body.lanes !== undefined) {
    if (!Array.isArray(body.lanes) || !body.lanes.length) return { ok: false, error: "lanes must be a non-empty array" };
    const lanes = [];
    const seen = new Set();
    for (const lane of body.lanes) {
      const id = String(lane?.id || "").trim();
      const label = String(lane?.label || "").trim();
      if (!id || !label) return { ok: false, error: "every lane needs an id and a label" };
      if (seen.has(id)) return { ok: false, error: `duplicate lane id: ${id}` };
      seen.add(id);
      const statuses = Array.isArray(lane.statuses) ? lane.statuses : [];
      if (!statuses.length) return { ok: false, error: `lane ${id} needs at least one status` };
      for (const status of statuses) {
        if (!WORK_ITEM_STATUSES.includes(status)) return { ok: false, error: `lane ${id} references unknown status: ${status}` };
      }
      const trigger = normalizeLaneTrigger(lane.trigger);
      if (!trigger.ok) return { ok: false, error: `lane ${id} trigger invalid: ${trigger.error}` };
      lanes.push({
        id,
        label,
        hint: String(lane.hint || "").slice(0, 200),
        empty: String(lane.empty || "").slice(0, 200),
        statuses,
        ...(trigger.value ? { trigger: trigger.value } : {})
      });
    }
    value.lanes = lanes;
  }
  return { ok: true, value };
}

function normalizeLaneTrigger(raw) {
  if (raw === undefined || raw === null || raw === false) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "trigger must be an object" };
  const mode = String(raw.mode || "none").trim();
  if (!BOARD_LANE_TRIGGER_MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of ${BOARD_LANE_TRIGGER_MODES.join(", ")}` };
  }
  if (mode === "none") return { ok: true, value: null };
  const workflow = String(raw.workflow || "").trim();
  const label = String(raw.label || "").trim() || triggerModeLabel(mode);
  const description = String(raw.description || "").trim().slice(0, 240);
  const input = raw.input && typeof raw.input === "object" && !Array.isArray(raw.input) ? raw.input : undefined;
  return {
    ok: true,
    value: {
      mode,
      label: label.slice(0, 80),
      ...(workflow ? { workflow } : {}),
      ...(description ? { description } : {}),
      ...(input ? { input } : {})
    }
  };
}

function triggerModeLabel(mode) {
  if (mode === "auto") return "Auto launch";
  if (mode === "confirm") return "Confirm launch";
  return "Suggest workflow";
}
