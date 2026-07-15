import { actorContextFromRequest, evaluateBoardMove, summarizeBoardTransitions } from "./boardTransitionPolicy.js";
import { boardToDefinition, developmentFactoryDefinition, validateBoardDefinition } from "./boardDefinition.js";
import { actorName } from "./routeActors.js";

// Board definition handlers: portable JSON documents describing whole
// kanbans. The read path (list/get/export) is any-scope; write paths
// (validate/import) mirror board create/update — an api/mcp/admin token.
export function createBoardDefinitionHandlers({
  createBoard,
  createSchedule,
  getBoard,
  getSchedule,
  listBoards,
  listSchedules,
  recordAudit,
  updateBoard,
  updateSchedule
} = {}) {
  const validateOrError = (res, body) => {
    const document = extractDocument(body);
    const validated = validateBoardDefinition(document);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return null;
    }
    return validated.value;
  };

  // Return the applied schedules (created or updated). Schedule slugs are
  // idempotent: on re-import, an existing schedule with the same slug is
  // updated in-place (cron/input/description) so agents can reconcile a
  // board definition without duplicating cron jobs.
  const applySchedules = (definition, actor) => {
    if (!definition.schedules?.length || typeof createSchedule !== "function") return [];
    const outcomes = [];
    const existing = new Map(
      (typeof listSchedules === "function" ? listSchedules() : []).map((entry) => [entry.name, entry])
    );
    for (const record of definition.schedules) {
      // Persisted schedules use `name` as the human key; board-definition
      // schedules carry a stable `slug` we mirror into the name field so
      // re-imports find the same row deterministically.
      const scheduleName = `board:${definition.slug}:${record.slug}`;
      const priorId = existing.get(scheduleName)?.id;
      const body = {
        name: scheduleName,
        workflowSlug: record.workflow,
        timezone: record.timezone,
        cron: record.cron || "",
        runAt: record.runAt || null,
        description: record.description || "",
        input: record.input || {},
        enabled: record.enabled !== false
      };
      try {
        const outcome = priorId
          ? { action: "updated", schedule: updateSchedule(priorId, body) }
          : { action: "created", schedule: createSchedule(body) };
        recordAudit(actor, `board_definition.schedule_${outcome.action}`, definition.slug, {
          scheduleId: outcome.schedule.id,
          workflow: record.workflow
        });
        outcomes.push({ ...outcome, laneId: record.laneId || null });
      } catch (error) {
        outcomes.push({ action: "failed", slug: record.slug, error: error.message });
      }
    }
    return outcomes;
  };

  return {
    listBoardDefinitions(_req, res) {
      const boards = typeof listBoards === "function" ? listBoards() : [];
      const documents = boards.map((board) => summarizeDefinition(board));
      res.json({ definitions: documents, examples: [{ slug: "runyard-development-factory", title: "RunYard Development Factory" }] });
    },

    exportBoardDefinition(req, res) {
      const board = getBoard(req.params.slug);
      if (!board) return res.status(404).json({ error: "board not found" });
      const definition = boardToDefinition(board);
      res.json({ definition });
    },

    getExampleBoardDefinition(req, res) {
      const slug = req.params.slug;
      if (slug === "runyard-development-factory") {
        return res.json({ definition: developmentFactoryDefinition() });
      }
      return res.status(404).json({ error: "unknown example definition" });
    },

    validateBoardDefinition(req, res) {
      const document = extractDocument(req.body);
      const validated = validateBoardDefinition(document);
      if (!validated.ok) return res.status(400).json({ valid: false, error: validated.error });
      const preview = {
        slug: validated.value.slug,
        title: validated.value.title,
        laneCount: validated.value.lanes.length,
        scheduleCount: validated.value.schedules?.length || 0,
        transitions: summarizeBoardTransitions({ lanes: validated.value.lanes })
      };
      res.json({ valid: true, definition: validated.value, preview });
    },

    importBoardDefinition(req, res) {
      const definition = validateOrError(res, req.body);
      if (!definition) return;
      const actor = actorName(req.token);
      const requestedSlug = String(req.body?.slug || definition.slug).trim();
      const existing = getBoard(requestedSlug);
      const boardBody = {
        slug: requestedSlug,
        title: definition.title,
        description: definition.description,
        project: definition.project,
        lanes: definition.lanes,
        defaultWorkflows: definition.defaultWorkflows,
        isDefault: definition.isDefault
      };
      let action;
      let board;
      try {
        if (existing) {
          board = updateBoard(requestedSlug, boardBody);
          action = "updated";
        } else {
          board = createBoard({ ...boardBody, createdBy: actor });
          action = "created";
        }
      } catch (error) {
        return res.status(409).json({ error: error.message });
      }
      recordAudit(actor, `board_definition.${action}`, board.id, {
        slug: board.slug,
        laneCount: board.lanes.length,
        scheduleCount: definition.schedules?.length || 0
      });
      const scheduleOutcomes = applySchedules(definition, actor);
      res.status(existing ? 200 : 201).json({
        action,
        board,
        schedules: scheduleOutcomes
      });
    },

    describeBoardTransitions(req, res) {
      const board = getBoard(req.params.slug);
      if (!board) return res.status(404).json({ error: "board not found" });
      res.json({
        board: { slug: board.slug, title: board.title },
        transitions: summarizeBoardTransitions(board)
      });
    },

    checkBoardTransition(req, res) {
      const board = getBoard(req.params.slug);
      if (!board) return res.status(404).json({ error: "board not found" });
      const { fromStatus, toStatus } = req.body || {};
      const actor = actorContextFromRequest(req, {
        role: req.body?.actorRole,
        runOrigin: req.body?.runOrigin,
        runId: req.body?.runId,
        workflowSlug: req.body?.workflowSlug
      });
      const decision = evaluateBoardMove(board, { fromStatus, toStatus, actor });
      res.json(decision);
    }
  };
}

// The definition doc may arrive under `definition:` (the standard envelope)
// or inline at the top level — accept either so agents don't fumble the
// shape when creating with a fresh document.
function extractDocument(body = {}) {
  if (body?.definition && typeof body.definition === "object") return body.definition;
  return body;
}

function summarizeDefinition(board) {
  return {
    slug: board.slug,
    title: board.title,
    laneCount: (board.lanes || []).length,
    project: board.project || "",
    isDefault: Boolean(board.isDefault),
    hasTransitionPolicy: (board.lanes || []).some((lane) => Array.isArray(lane.transitions) && lane.transitions.length)
  };
}
