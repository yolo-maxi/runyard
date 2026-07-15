import { actorContextFromRequest, evaluateBoardMove } from "./boardTransitionPolicy.js";
import { boundedLimit } from "./httpQuery.js";
import { actorName } from "./routeActors.js";
import { validateWorkItemBody, withWorkItemView } from "./workItemHelpers.js";

// Work items ("tickets"): the durable unit of company work. Handlers stay
// thin — validation in workItemHelpers, persistence + ticket history in
// workItemStore. Humans/agents own ticket state through PATCH; linked runs
// also move tickets where the mapping is reliable (src/workItemRunSync.js),
// and every automated move lands in ticket history with the run as actor.
export function createWorkItemHandlers({
  createWorkItem,
  deleteWorkItem,
  getRun,
  getWorkItem,
  linkRunToWorkItem,
  listApprovals,
  listArtifacts,
  listBoards,
  listWorkItemEvents,
  listWorkItemRuns,
  listWorkItems,
  recordAudit,
  syncWorkItemForRun,
  unlinkRunFromWorkItem,
  updateWorkItem,
  withRunLinks,
  workItemRunSummaries
} = {}) {
  // Boards whose scope includes this ticket. Every board with a matching
  // project (or an empty "all projects" scope) applies its transition policy
  // to the move; if any board's explicit rule denies, the PATCH is rejected.
  // Preserves today's behaviour when no board declares a matching rule.
  const applicableBoards = (workItem) => {
    if (typeof listBoards !== "function") return [];
    const project = workItem.project || "";
    return listBoards().filter((board) => !board.project || board.project === project);
  };
  const workItemOr404 = (req, res) => {
    const workItem = getWorkItem(req.params.id);
    if (!workItem) {
      res.status(404).json({ error: "work item not found" });
      return null;
    }
    return workItem;
  };

  const sendValidationError = (res, validated) => {
    if (validated.ok) return false;
    res.status(400).json({ error: validated.error });
    return true;
  };

  const linkResult = (req, res, result, action) => {
    if (!result.ok) return res.status(result.code || 400).json({ error: result.error });
    const actor = actorName(req.token);
    recordAudit(actor, action, req.params.id, { runId: result.runId });
    // Linking an existing run adopts its state: a running run puts the
    // ticket In motion, a held one parks it in waiting, etc.
    if (action === "work_item.run_linked" && syncWorkItemForRun && getRun) {
      syncWorkItemForRun(getRun(result.runId), { trigger: "run_linked" });
    }
    res.json({
      linked: action === "work_item.run_linked",
      workItem: withWorkItemView(getWorkItem(req.params.id)),
      runId: result.runId
    });
  };

  return {
    listWorkItems(req, res) {
      const query = req.query || {};
      const items = listWorkItems({
        status: String(query.status || "").trim(),
        project: String(query.project || "").trim(),
        owner: String(query.owner || "").trim(),
        type: String(query.type || "").trim(),
        q: String(query.q || "").trim(),
        includeArchived: String(query.includeArchived || "") === "true",
        limit: boundedLimit(query.limit, 200, 500)
      });
      const summaries = workItemRunSummaries();
      res.json({
        workItems: items.map((item) => withWorkItemView(item, summaries.get(item.id) || null))
      });
    },

    getWorkItem(req, res) {
      const workItem = workItemOr404(req, res);
      if (!workItem) return;
      const runs = listWorkItemRuns(workItem.id).map((run) => withRunLinks(run));
      const runIds = new Set(runs.map((run) => run.id));
      const approvals = listApprovals("").filter((approval) => runIds.has(approval.runId));
      const artifacts = runs.flatMap((run) => listArtifacts({ runId: run.id }));
      res.json({
        workItem: withWorkItemView(workItem, summaryFromRuns(runs)),
        runs,
        approvals,
        artifacts,
        events: listWorkItemEvents(workItem.id)
      });
    },

    createWorkItem(req, res) {
      const validated = validateWorkItemBody(req.body || {}, { partial: false });
      if (sendValidationError(res, validated)) return;
      const actor = actorName(req.token);
      const workItem = createWorkItem({ ...validated.value, createdBy: actor, requester: validated.value.requester || actor });
      recordAudit(actor, "work_item.created", workItem.id, { title: workItem.title, status: workItem.status });
      res.status(201).json({ workItem: withWorkItemView(workItem) });
    },

    updateWorkItem(req, res) {
      const existing = workItemOr404(req, res);
      if (!existing) return;
      const validated = validateWorkItemBody(req.body || {}, { partial: true });
      if (sendValidationError(res, validated)) return;
      // Transition policy: when the PATCH changes status, evaluate every
      // in-scope board's transition policy before mutating state. A denied
      // move short-circuits with 409 + the board's message; policy-free
      // moves fall through (today's behaviour). `boardSlug`/`actorRole` on
      // the body let an agent or workflow declare itself when driving the
      // move; without them the caller is treated as manual/human.
      if (validated.value.status && validated.value.status !== existing.status) {
        const actorContext = actorContextFromRequest(req, {
          role: req.body?.actorRole,
          runOrigin: req.body?.runOrigin,
          runId: req.body?.runId,
          workflowSlug: req.body?.workflowSlug
        });
        const boards = req.body?.boardSlug
          ? applicableBoards(existing).filter((board) => board.slug === req.body.boardSlug)
          : applicableBoards(existing);
        for (const board of boards) {
          const decision = evaluateBoardMove(board, {
            fromStatus: existing.status,
            toStatus: validated.value.status,
            actor: actorContext
          });
          if (!decision.ok) {
            return res.status(409).json({
              error: decision.error,
              board: board.slug,
              transition: decision.transition ? { from: decision.transition.from, to: decision.transition.to } : undefined
            });
          }
        }
      }
      const actor = actorName(req.token);
      const workItem = updateWorkItem(req.params.id, validated.value, { actor });
      recordAudit(actor, "work_item.updated", workItem.id, { fields: Object.keys(validated.value) });
      res.json({ workItem: withWorkItemView(workItem) });
    },

    deleteWorkItem(req, res) {
      const deleted = deleteWorkItem(req.params.id);
      if (!deleted) return res.status(404).json({ error: "work item not found" });
      recordAudit(actorName(req.token), "work_item.deleted", req.params.id, { title: deleted.title });
      res.json({ deleted: true, workItem: withWorkItemView(deleted) });
    },

    linkWorkItemRun(req, res) {
      if (!workItemOr404(req, res)) return;
      const runId = String(req.body?.runId || "").trim();
      if (!runId) return res.status(400).json({ error: "runId is required" });
      const result = linkRunToWorkItem(req.params.id, runId, { actor: actorName(req.token) });
      linkResult(req, res, result, "work_item.run_linked");
    },

    unlinkWorkItemRun(req, res) {
      if (!workItemOr404(req, res)) return;
      const runId = String(req.body?.runId || "").trim();
      if (!runId) return res.status(400).json({ error: "runId is required" });
      const result = unlinkRunFromWorkItem(req.params.id, runId, { actor: actorName(req.token) });
      linkResult(req, res, result, "work_item.run_unlinked");
    }
  };
}

// Detail pages already fetch the item's runs — derive the same rollup shape
// the list view gets from workItemRunSummaries without a second query.
function summaryFromRuns(runs = []) {
  if (!runs.length) return null;
  const byStatus = {};
  let lastRunAt = null;
  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] || 0) + 1;
    if (!lastRunAt || String(run.createdAt) > lastRunAt) lastRunAt = run.createdAt;
  }
  return { total: runs.length, byStatus, lastRunAt };
}
