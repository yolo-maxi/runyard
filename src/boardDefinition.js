import {
  BOARD_TRANSITION_ACTOR_ROLES,
  DEFAULT_BOARD_LANES,
  validateBoardBody
} from "./boardRecords.js";
import { WORK_ITEM_STATUSES } from "./workItemRecords.js";

// Board definitions: portable, dependency-free JSON documents that describe
// a whole kanban — lanes, statuses, lane-enter triggers, guards, transition
// policy, and optional schedule hookups. A definition is what an agent
// writes, ships, imports and exports; a board (in the DB) is one *instance*
// of a definition. This split lets a company deploy one hub and provision
// many kanbans at will from portable YAML/JSON files without touching the
// SQL layer directly.
//
// The document format is intentionally minimal and stable:
//   - `kind: "runyard.board"` + `version: 1` — so future revisions can add
//     fields without silently mis-importing today's files;
//   - `slug/title/description/project/isDefault/defaultWorkflows` — same
//     board shape the store already accepts;
//   - `lanes[]` — each lane carries its statuses, hint/empty, an optional
//     `trigger` (workflow suggestion) and `guard` (allow/deny status
//     entries), and a `transitions[]` array — the transition policy
//     enforced by boardTransitionPolicy.js.
//   - `schedules[]` — optional schedule hookups the importer creates
//     alongside the board, so `lane.trigger` can point at a cron cadence
//     without needing a second round-trip.
//
// YAML support is deliberately deferred: JSON is enough today and adding a
// YAML parser would drag a runtime dependency into the CLI/MCP bin path.
// The document format itself is trivially expressible in YAML; the docs
// site describes JSON now and leaves YAML as an explicit future syntax.

export const BOARD_DEFINITION_KIND = "runyard.board";
export const BOARD_DEFINITION_VERSION = 1;

// Re-export so callers only need to import one module.
export { BOARD_TRANSITION_ACTOR_ROLES };

const SCHEDULE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Normalize a raw JSON document into a canonical board-definition value.
// Returns { ok, value } or { ok:false, error }. The importer then feeds
// `value` to boardStore.createBoard / updateBoard.
export function validateBoardDefinition(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "definition must be a JSON object" };
  }
  const kind = raw.kind == null ? BOARD_DEFINITION_KIND : String(raw.kind);
  if (kind !== BOARD_DEFINITION_KIND) return { ok: false, error: `unknown kind: ${kind}` };
  const version = raw.version == null ? BOARD_DEFINITION_VERSION : Number(raw.version);
  if (!Number.isInteger(version) || version < 1 || version > BOARD_DEFINITION_VERSION) {
    return { ok: false, error: `unsupported definition version: ${raw.version}` };
  }

  // validateBoardBody already understands lanes + guards + triggers +
  // transitions, so we lean on it here; a definition is *the* board body
  // plus a portable-document envelope.
  const base = validateBoardBody(raw, { partial: false });
  if (!base.ok) return { ok: false, error: base.error };

  const schedules = normalizeSchedules(raw.schedules, {
    laneIds: new Set(base.value.lanes.map((lane) => lane.id))
  });
  if (!schedules.ok) return schedules;

  return {
    ok: true,
    value: {
      kind: BOARD_DEFINITION_KIND,
      version: BOARD_DEFINITION_VERSION,
      slug: base.value.slug,
      title: base.value.title,
      description: base.value.description || "",
      project: base.value.project || "",
      defaultWorkflows: base.value.defaultWorkflows || [],
      isDefault: base.value.isDefault === true,
      lanes: base.value.lanes,
      ...(schedules.value.length ? { schedules: schedules.value } : {})
    }
  };
}

function normalizeSchedules(raw, { laneIds } = {}) {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "schedules must be an array" };
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "schedule entry must be an object" };
    }
    const slug = String(entry.slug || "").trim();
    if (!slug || !SCHEDULE_SLUG_PATTERN.test(slug)) {
      return { ok: false, error: `schedule slug must be lowercase letters/digits/hyphens: ${entry.slug}` };
    }
    if (seen.has(slug)) return { ok: false, error: `duplicate schedule slug: ${slug}` };
    seen.add(slug);
    const workflow = String(entry.workflow || entry.workflowSlug || "").trim();
    if (!workflow) return { ok: false, error: `schedule ${slug} needs a workflow slug` };
    const cron = String(entry.cron || "").trim();
    const runAt = entry.runAt ? String(entry.runAt).trim() : "";
    if (!cron && !runAt) return { ok: false, error: `schedule ${slug} needs cron or runAt` };
    const laneId = entry.laneId ? String(entry.laneId).trim() : "";
    if (laneId && laneIds && !laneIds.has(laneId)) {
      return { ok: false, error: `schedule ${slug} laneId not in board lanes: ${laneId}` };
    }
    const record = {
      slug,
      name: String(entry.name || slug).trim().slice(0, 120),
      workflow,
      ...(cron ? { cron } : {}),
      ...(runAt ? { runAt } : {}),
      timezone: String(entry.timezone || "UTC").trim() || "UTC",
      description: String(entry.description || "").slice(0, 500),
      input: entry.input && typeof entry.input === "object" && !Array.isArray(entry.input) ? entry.input : {},
      enabled: entry.enabled === false ? false : true
    };
    if (laneId) record.laneId = laneId;
    out.push(record);
  }
  return { ok: true, value: out };
}

// Turn a stored board row into a portable definition document (the inverse
// of validateBoardDefinition). The exported document round-trips through
// import without loss beyond runtime metadata (ids, timestamps).
export function boardToDefinition(board, { schedules = [] } = {}) {
  if (!board) return null;
  const doc = {
    kind: BOARD_DEFINITION_KIND,
    version: BOARD_DEFINITION_VERSION,
    slug: board.slug,
    title: board.title,
    description: board.description || "",
    project: board.project || "",
    defaultWorkflows: board.defaultWorkflows || [],
    isDefault: Boolean(board.isDefault),
    lanes: (board.lanes || []).map(cloneLane)
  };
  if (schedules?.length) {
    doc.schedules = schedules.map(cloneScheduleForExport);
  }
  return doc;
}

function cloneLane(lane) {
  const clone = {
    id: lane.id,
    label: lane.label,
    statuses: [...(lane.statuses || [])]
  };
  if (lane.hint) clone.hint = lane.hint;
  if (lane.empty) clone.empty = lane.empty;
  if (lane.trigger) clone.trigger = { ...lane.trigger };
  if (lane.guard) clone.guard = { ...lane.guard };
  if (Array.isArray(lane.transitions) && lane.transitions.length) {
    clone.transitions = lane.transitions.map((transition) => ({
      to: transition.to,
      allow: { ...transition.allow },
      ...(transition.message ? { message: transition.message } : {})
    }));
  }
  return clone;
}

function cloneScheduleForExport(entry) {
  const out = {
    slug: entry.slug,
    name: entry.name,
    workflow: entry.workflow,
    timezone: entry.timezone || "UTC",
    input: entry.input || {},
    enabled: entry.enabled !== false
  };
  if (entry.cron) out.cron = entry.cron;
  if (entry.runAt) out.runAt = entry.runAt;
  if (entry.description) out.description = entry.description;
  if (entry.laneId) out.laneId = entry.laneId;
  return out;
}

// Canonical RunYard Development Factory definition — the same document
// that ships as an importable example under workflow-templates/. Building
// it in code (rather than reading the JSON file) lets tests round-trip it
// through validate/import without touching the filesystem.
export function developmentFactoryDefinition({
  slug = "runyard-development-factory",
  title = "RunYard Development Factory",
  project = ""
} = {}) {
  const lanes = DEFAULT_BOARD_LANES.map((lane) => ({ ...lane }));
  const withPolicy = lanes.map((lane) => {
    if (lane.id === "ready") {
      return {
        ...lane,
        transitions: [
          {
            to: "running",
            allow: {
              manual: true,
              workflows: ["runyard-smoke-check", "implement-change-gated"],
              runOrigins: ["schedule"]
            }
          }
        ]
      };
    }
    if (lane.id === "running") {
      return {
        ...lane,
        transitions: [
          { to: "review", allow: { manual: true, runOrigins: ["workflow", "schedule"] } },
          { to: "attention", allow: { manual: true, runOrigins: ["workflow"] } }
        ]
      };
    }
    if (lane.id === "review") {
      return {
        ...lane,
        transitions: [
          {
            to: "shipped",
            allow: { manual: true, actorRoles: ["human"] },
            message: "Only humans mark shipped from Review."
          }
        ]
      };
    }
    return lane;
  });
  for (const lane of withPolicy) {
    for (const status of lane.statuses) {
      if (!WORK_ITEM_STATUSES.includes(status)) {
        throw new Error(`developmentFactoryDefinition: invalid status ${status}`);
      }
    }
  }
  return {
    kind: BOARD_DEFINITION_KIND,
    version: BOARD_DEFINITION_VERSION,
    slug,
    title,
    description: "The RunYard software factory: triage → plan → ready → run → review → ship, with agent/schedule hookups for the routine transitions and a human-only gate on shipping.",
    project,
    defaultWorkflows: ["runyard-smoke-check", "implement-change-gated", "docs-update"],
    isDefault: false,
    lanes: withPolicy,
    schedules: [
      {
        slug: "runyard-nightly-smoke",
        name: "RunYard nightly smoke",
        workflow: "runyard-smoke-check",
        cron: "0 3 * * *",
        timezone: "UTC",
        description: "Nightly smoke-check the deployment can execute a workflow end-to-end; wires into the Ready → In motion transition.",
        input: {},
        enabled: false,
        laneId: "ready"
      }
    ]
  };
}
