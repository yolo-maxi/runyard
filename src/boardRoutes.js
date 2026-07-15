import { actorName } from "./routeActors.js";
import { validateBoardBody } from "./boardRecords.js";
import { withWorkItemView } from "./workItemHelpers.js";

// Boards ("factory surfaces"): configured views over work items. Handlers
// stay thin — validation in boardRecords, persistence in boardStore. GET of
// one board returns the whole operating picture (board config + lane counts
// + decorated work items) so the CLI/MCP can render the factory in one call.
export function createBoardHandlers({
  createBoard,
  getBoard,
  listBoards,
  listWorkItems,
  recordAudit,
  updateBoard,
  workItemRunSummaries
} = {}) {
  const boardOr404 = (req, res) => {
    const board = getBoard(req.params.slug);
    if (!board) {
      res.status(404).json({ error: "board not found" });
      return null;
    }
    return board;
  };

  const boardWorkItems = (board, { includeArchived = false } = {}) => {
    const items = listWorkItems({ project: board.project || "", includeArchived });
    const summaries = workItemRunSummaries();
    return items.map((item) => withWorkItemView(item, summaries.get(item.id) || null));
  };

  const laneCounts = (board, items) =>
    (board.lanes || []).map((lane) => ({
      ...lane,
      count: items.filter((item) => lane.statuses.includes(item.status)).length
    }));

  return {
    listBoards(req, res) {
      res.json({ boards: listBoards() });
    },

    getBoard(req, res) {
      const board = boardOr404(req, res);
      if (!board) return;
      const includeArchived = String(req.query?.includeArchived || "") === "true";
      const workItems = boardWorkItems(board, { includeArchived });
      res.json({ board, lanes: laneCounts(board, workItems), workItems });
    },

    createBoard(req, res) {
      const validated = validateBoardBody(req.body || {}, { partial: false });
      if (!validated.ok) return res.status(400).json({ error: validated.error });
      const actor = actorName(req.token);
      let board;
      try {
        board = createBoard({ ...validated.value, createdBy: actor });
      } catch (error) {
        return res.status(409).json({ error: error.message });
      }
      recordAudit(actor, "board.created", board.id, { slug: board.slug, title: board.title });
      res.status(201).json({ board });
    },

    updateBoard(req, res) {
      if (!boardOr404(req, res)) return;
      const validated = validateBoardBody(req.body || {}, { partial: true });
      if (!validated.ok) return res.status(400).json({ error: validated.error });
      const actor = actorName(req.token);
      const board = updateBoard(req.params.slug, validated.value);
      recordAudit(actor, "board.updated", board.id, { slug: board.slug, fields: Object.keys(validated.value) });
      res.json({ board });
    }
  };
}
