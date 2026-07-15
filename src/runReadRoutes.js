import { buildRunFlow } from "./runFlow.js";
import { withWorkItemView } from "./workItemHelpers.js";
import { buildRunTimeline, timelinePage } from "./runTimeline.js";
import { runBudgetStatus, runBudgetStop } from "./runBudget.js";
import { usageSummaryDays } from "./usageSummary.js";
import { redactSnippet, summarizeRunEvents } from "./runEventSummary.js";
import { buildQueueIndex } from "./runPresentation.js";
import {
  runListFilterResponse,
  runListPage,
  runListQuery
} from "./runReadList.js";

export { runListQuery } from "./runReadList.js";

// budget_exceeded runs older than this stop demanding attention: their fix
// (raise the budget and rerun) has usually been taken or consciously skipped.
const ATTENTION_BUDGET_STOP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ATTENTION_LIST_LIMIT = 100;

export function createRunReadHandlers({
  countPendingApprovals = () => 0,
  countRuns,
  decorateSingleRun,
  getRun,
  getRunUsage = () => null,
  getWorkItem = () => null,
  hiddenRunSlugs = [],
  listArtifacts,
  listRunEvents,
  listRunResponseEndpointsForRun,
  listRuns,
  pendingApprovalsForRun = () => [],
  presentRunResponseEndpoint,
  reapStuckRunsWithRetrospectives,
  runApprovalHold = () => false,
  runDeadlineMs = () => 0,
  runDiagnostics,
  runnerPoolStats,
  runTimelineEnabled,
  runWorkflowGraph = () => null,
  subscribeRunEvents,
  usageSummary = () => ({ totals: null, byWorkflow: [], budgetStopped: 0 }),
  withArtifactLinks,
  withRunLinks
} = {}) {
  const loadRun = (req, res) => {
    const run = getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return null;
    }
    return run;
  };
  const runEvents = (run) => listRunEvents(run.id);
  const linkedRunArtifacts = (run) => listArtifacts({ runId: run.id }).map(withArtifactLinks);

  return {
    listRuns(req, res) {
      reapStuckRunsWithRetrospectives(runDeadlineMs());
      const query = runListQuery(req.query || {}, hiddenRunSlugs);
      const { rows, total, nextCursor } = runListPage({ countRuns, listRuns, query });
      const queueRows = query.status === "queued" && !query.filtered ? rows : listRuns({ status: "queued", limit: 500 });
      const queueIndex = buildQueueIndex(queueRows);
      res.json({
        runs: rows.map((run) => withRunLinks(run, queueIndex)),
        total,
        limit: query.limit,
        nextCursor,
        pool: runnerPoolStats(),
        ...(query.capability ? { capability: query.capability } : {}),
        ...(query.workflowSlugs.length ? { workflows: query.workflowSlugs } : {}),
        ...(query.filtered ? { filters: runListFilterResponse(query) } : {})
      });
    },

    // The operator triage queue: every run whose next step is a human action —
    // paused (resume), waiting on an approval (decide), or stopped at its
    // budget recently (raise the budget and rerun, or accept the stop). One
    // call answers "is anything silently stuck?" for dashboards, MCP agents,
    // and `runyard attention`.
    listAttentionRuns(_req, res) {
      const pick = (options) => listRuns({ limit: ATTENTION_LIST_LIMIT, ...options }).map((run) => withRunLinks(run));
      const paused = pick({ status: "paused" });
      const waitingApproval = pick({ status: "waiting_approval" });
      const budgetStopped = pick({
        status: "budget_exceeded",
        since: new Date(Date.now() - ATTENTION_BUDGET_STOP_WINDOW_MS).toISOString()
      });
      res.json({
        attention: { paused, waitingApproval, budgetStopped },
        counts: {
          paused: paused.length,
          waitingApproval: waitingApproval.length,
          budgetStopped: budgetStopped.length,
          pendingApprovals: countPendingApprovals()
        },
        generatedAt: new Date().toISOString()
      });
    },

    getUsageSummary(req, res) {
      const days = usageSummaryDays(req.query?.days);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      res.json({ window: { days, since }, ...usageSummary({ since }) });
    },

    getRun(req, res) {
      const run = loadRun(req, res);
      if (!run) return;
      res.json(runDetailPayload({
        approvalHold: runApprovalHold(run),
        artifacts: linkedRunArtifacts(run),
        decorateSingleRun,
        events: runEvents(run),
        listRunResponseEndpointsForRun,
        presentRunResponseEndpoint,
        run,
        runDiagnostics,
        runnerPoolStats,
        workItem: run.workItemId ? getWorkItem(run.workItemId) : null
      }));
    },

    listRunEvents(req, res) {
      res.json({ events: listRunEvents(req.params.id) });
    },

    streamRunEvents(req, res) {
      const run = loadRun(req, res);
      if (!run) return;
      streamRunEventsResponse({ req, res, run, listRunEvents, subscribeRunEvents });
    },

    getRunLogSummary(req, res) {
      const run = loadRun(req, res);
      if (!run) return;
      res.json({ run: withRunLinks(run), logSummary: summarizeRunEvents(runEvents(run)) });
    },

    getRunDiagnostics(req, res) {
      const run = loadRun(req, res);
      if (!run) return;
      const events = runEvents(run);
      const artifacts = linkedRunArtifacts(run);
      res.json({
        run: withRunLinks(run),
        diagnostics: runDiagnostics(run, events, artifacts),
        logSummary: summarizeRunEvents(events)
      });
    },

    getRunLogs(req, res) {
      const logs = listRunEvents(req.params.id)
        .map((event) => `[${event.createdAt}] ${event.type}: ${redactSnippet(event.message, 4000)}`)
        .join("\n");
      res.type("text/plain").send(logs);
    },

    getRunUsage(req, res) {
      const run = loadRun(req, res);
      if (!run) return;
      const usage = getRunUsage(run.id);
      res.json({
        ...usage,
        status: run.status,
        budgetStatus: runBudgetStatus(run.budget, run.usage),
        budgetStop: runBudgetStop(run)
      });
    },

    // Execution flow: the static workflow graph with the run's event stream
    // folded onto it — one state per step (pending/active/done/failed/waiting/
    // cancelled/skipped). Degrades to an event-derived stepper when no source
    // graph is available; see src/runFlow.js for the fold rules.
    getRunFlow(req, res) {
      const run = loadRun(req, res);
      if (!run) return;
      res.json(buildRunFlow({
        run,
        graph: runWorkflowGraph(run),
        events: runEvents(run),
        pendingApprovals: pendingApprovalsForRun(run.id)
      }));
    },

    getRunTimeline(req, res) {
      if (!runTimelineEnabled()) return res.status(404).json({ error: "run timeline disabled" });
      const run = loadRun(req, res);
      if (!run) return;
      const sorted = buildRunTimeline(run, {
        events: runEvents(run),
        artifacts: listArtifacts({ runId: run.id }),
        withArtifactLinks
      });
      res.json({
        runId: run.id,
        ...timelinePage(sorted, {
          since: String(req.query.since || "").trim(),
          limit: Number(req.query.limit)
        })
      });
    }
  };
}

export function runDetailPayload({
  approvalHold = false,
  artifacts,
  decorateSingleRun,
  events,
  listRunResponseEndpointsForRun,
  presentRunResponseEndpoint,
  run,
  runDiagnostics,
  runnerPoolStats,
  workItem = null
}) {
  const responseEndpoints = listRunResponseEndpointsForRun(run.id).map(presentRunResponseEndpoint);
  return {
    run: decorateSingleRun(run),
    // Hydrated work item ("ticket") this run executes for; null when unlinked.
    ...(workItem ? { workItem: withWorkItemView(workItem) } : {}),
    // True while a human decision is pending on this run. Runners use this to
    // defer their execution deadline instead of timing the run out under the
    // human.
    approvalHold: Boolean(approvalHold),
    events,
    artifacts,
    responseEndpoints,
    // Non-null only for budget_exceeded runs; saves detail readers a second
    // request to /runs/{id}/usage just to learn why the run stopped.
    budgetStop: runBudgetStop(run),
    diagnostics: runDiagnostics(run, events, artifacts),
    logSummary: summarizeRunEvents(events),
    pool: runnerPoolStats()
  };
}

export function streamRunEventsResponse({ req, res, run, listRunEvents, subscribeRunEvents }) {
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();
  res.write(": connected\n\n");
  const existing = listRunEvents(run.id);
  const lastId = existing.length ? existing[existing.length - 1].id : null;
  res.write(`event: ready\ndata: ${JSON.stringify({ runId: run.id, lastEventId: lastId, count: existing.length })}\n\n`);

  const send = (event) => {
    try {
      res.write(`event: run-event\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // The close handlers below own stream cleanup.
    }
  };
  const unsubscribe = subscribeRunEvents(run.id, send);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 25_000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}
