// Board transition policy: given a board's lane definitions, a work-item
// status change, and the acting context (human/agent/workflow), decide
// whether the move is allowed and — if not — return a human-legible reason.
//
// This module is deliberately pure: no DB reads, no side effects. Callers
// (workItemRoutes on PATCH status, the /api/boards/:slug/move endpoint,
// tests) pass in the board rows and the actor context; the answer is a
// tight { ok, error, transition } record. That keeps the same evaluator
// safe to invoke on the API, the CLI (for `runyard board policy <slug>`)
// and the MCP tool (`describe_board_transitions`) without divergence.
//
// The evaluator returns "unrestricted" when the board has no policy for
// the from→to move: today's behaviour (any authenticated caller can move a
// ticket) is preserved unless the board author explicitly opts in.
//
// Actor context shape (all optional):
//   { role, id, scopes: [], runOrigin, runId, workflowSlug, workflowLabel }
//
//   - role       one of BOARD_TRANSITION_ACTOR_ROLES (defaults to "manual")
//   - id/name    a stable actor identifier (token name, run id, schedule id)
//   - scopes     the token scopes (used to derive `agent` vs `human`)
//   - runOrigin  when the move is caused by a run, its origin.type
//   - runId      matched against transition.allow.actors as `run:<id>`
//   - workflowSlug when the move is caused by a workflow's run
//   - workflowLabel when the move is caused by a workflow's run (for msg)

import { WORK_ITEM_STATUSES } from "./workItemRecords.js";

// Map a lifecycle status to the lane id that carries it, on this board.
// Multiple statuses can share a lane; multiple lanes cannot share a status
// (validateBoardBody enforces uniqueness of lane ids, and per-lane statuses
// are additive: the FIRST lane declaring the status wins deterministically).
export function laneForStatus(board, status) {
  if (!board || !status) return null;
  for (const lane of board.lanes || []) {
    if ((lane.statuses || []).includes(status)) return lane;
  }
  return null;
}

// Find the transition rule from `from` lane to `to` lane on this board.
// Returns null when no explicit rule exists; the caller then treats it as
// unrestricted (see below).
export function findTransition(board, fromLaneId, toLaneId) {
  if (!board || !fromLaneId || !toLaneId) return null;
  const lane = (board.lanes || []).find((l) => l.id === fromLaneId);
  if (!lane) return null;
  const list = Array.isArray(lane.transitions) ? lane.transitions : [];
  return list.find((transition) => transition.to === toLaneId) || null;
}

// Evaluate a proposed status move against the board's policy.
export function evaluateBoardMove(board, { fromStatus, toStatus, actor = {} } = {}) {
  if (!board) return { ok: true, unrestricted: true };
  if (!toStatus) return { ok: false, error: "target status is required" };
  if (fromStatus === toStatus) return { ok: true, noop: true };
  if (!WORK_ITEM_STATUSES.includes(toStatus)) {
    return { ok: false, error: `unknown target status: ${toStatus}` };
  }
  const fromLane = laneForStatus(board, fromStatus);
  const toLane = laneForStatus(board, toStatus);
  // Guards on the destination lane still apply — the guard is the pre-policy
  // gate on entering the lane at all, regardless of who's driving the move.
  const guard = toLane?.guard;
  if (guard) {
    if (guard.allowFromStatuses?.length && !guard.allowFromStatuses.includes(fromStatus)) {
      return { ok: false, error: guard.message || `moves into ${toLane.label || toLane.id} must come from ${guard.allowFromStatuses.join(", ")}` };
    }
    if (guard.denyFromStatuses?.length && guard.denyFromStatuses.includes(fromStatus)) {
      return { ok: false, error: guard.message || `moves into ${toLane.label || toLane.id} may not come from ${fromStatus}` };
    }
  }
  // No cross-lane hop → no policy (in-lane status refinements are allowed).
  if (!fromLane || !toLane || fromLane.id === toLane.id) return { ok: true, unrestricted: true };
  const transition = findTransition(board, fromLane.id, toLane.id);
  if (!transition) {
    // No explicit rule: preserve today's behaviour. This is what a board
    // written without transitions[] looks like — a plain configured view.
    return { ok: true, unrestricted: true, fromLane, toLane };
  }
  const decision = decideActorAllowed(transition.allow || { manual: true }, actor);
  if (!decision.ok) {
    return {
      ok: false,
      error: transition.message || decision.error,
      transition,
      fromLane,
      toLane
    };
  }
  return { ok: true, transition, fromLane, toLane };
}

// Given an allow-clause and an actor context, decide whether the move is
// allowed. Multiple channels (manual/workflows/runOrigins/actors/actorRoles)
// are OR-ed together — the allow-clause is a union, not an intersection.
function decideActorAllowed(allow, actor) {
  const role = normalizeActorRole(actor);
  if (allow.manual && (role === "manual" || role === "human")) return { ok: true, matched: "manual" };
  if (allow.actors?.length) {
    const label = actorLabel(actor);
    if (label && allow.actors.includes(label)) return { ok: true, matched: `actor:${label}` };
    if (actor.id && allow.actors.includes(actor.id)) return { ok: true, matched: `actor:${actor.id}` };
    if (actor.runId && allow.actors.includes(`run:${actor.runId}`)) return { ok: true, matched: `actor:run:${actor.runId}` };
  }
  if (allow.workflows?.length && actor.workflowSlug && allow.workflows.includes(actor.workflowSlug)) {
    return { ok: true, matched: `workflow:${actor.workflowSlug}` };
  }
  if (allow.runOrigins?.length && actor.runOrigin && allow.runOrigins.includes(actor.runOrigin)) {
    return { ok: true, matched: `runOrigin:${actor.runOrigin}` };
  }
  if (allow.actorRoles?.length && allow.actorRoles.includes(role)) return { ok: true, matched: `actorRole:${role}` };
  // Nothing matched. Build a specific error that mentions what would have
  // worked — the client can then relaunch with the right role/workflow.
  const permitted = describeAllow(allow);
  return { ok: false, error: `transition not permitted for ${role || "this caller"}${permitted ? ` — allowed: ${permitted}` : ""}` };
}

// Best-effort role for an actor: token scopes with "admin" or none default
// to `human` (a person driving the API); tokens carrying `runner` scope
// come from a runner; explicit role/runOrigin wins over the heuristic.
function normalizeActorRole(actor = {}) {
  if (actor.role && typeof actor.role === "string") return actor.role;
  if (actor.runOrigin === "schedule") return "schedule";
  if (actor.workflowSlug) return "workflow";
  const scopes = Array.isArray(actor.scopes) ? actor.scopes : [];
  if (scopes.includes("runner")) return "runner";
  if (scopes.length && !scopes.includes("admin") && !scopes.includes("api")) return "agent";
  return "human";
}

function actorLabel(actor = {}) {
  if (actor.label && typeof actor.label === "string") return actor.label;
  if (actor.name && typeof actor.name === "string") return actor.name;
  return "";
}

function describeAllow(allow = {}) {
  const bits = [];
  if (allow.manual) bits.push("manual moves");
  if (allow.workflows?.length) bits.push(`workflows: ${allow.workflows.join(", ")}`);
  if (allow.runOrigins?.length) bits.push(`run origins: ${allow.runOrigins.join(", ")}`);
  if (allow.actors?.length) bits.push(`actors: ${allow.actors.join(", ")}`);
  if (allow.actorRoles?.length) bits.push(`roles: ${allow.actorRoles.join(", ")}`);
  return bits.join(" · ");
}

// Convenience: describe a board's whole transition policy as a flat list —
// used by the CLI `board policy <slug>`, the MCP describe_board_transitions
// tool, and the Flow view labels. Keeps the shape stable.
export function summarizeBoardTransitions(board) {
  if (!board) return [];
  const summaries = [];
  for (const lane of board.lanes || []) {
    for (const transition of lane.transitions || []) {
      summaries.push({
        from: lane.id,
        fromLabel: lane.label,
        to: transition.to,
        toLabel: (board.lanes || []).find((l) => l.id === transition.to)?.label || transition.to,
        allow: { ...(transition.allow || { manual: true }) },
        message: transition.message || ""
      });
    }
  }
  return summaries;
}

// Build an actor context from an authenticated Express req + optional run.
// Handlers use this so they don't each re-derive scopes/role/runOrigin.
export function actorContextFromRequest(req = {}, extra = {}) {
  const token = req.token || {};
  const scopes = Array.isArray(token.scopes) ? token.scopes : [];
  // Do not let ordinary API callers self-assert that a move came from a
  // privileged workflow/schedule/runner. The authenticated token is the
  // identity boundary; runner/admin-scoped callers may carry run metadata
  // because they are the execution path that can honestly know it.
  const canAssertRunContext = scopes.includes("runner") || scopes.includes("admin");
  return {
    id: token.id || "",
    name: token.name || "",
    scopes,
    role: canAssertRunContext ? extra.role : undefined,
    runOrigin: canAssertRunContext ? extra.runOrigin : undefined,
    runId: canAssertRunContext ? extra.runId : undefined,
    workflowSlug: canAssertRunContext ? extra.workflowSlug : undefined,
    workflowLabel: canAssertRunContext ? extra.workflowLabel : undefined,
    label: canAssertRunContext ? extra.label : undefined
  };
}
