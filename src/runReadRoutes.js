import { buildRunTimeline, timelinePage } from "./runTimeline.js";
import { redactSnippet, summarizeRunEvents } from "./runEventSummary.js";
import { buildQueueIndex } from "./runPresentation.js";
import {
  runListFilterResponse,
  runListPage,
  runListQuery
} from "./runReadList.js";

export { runListQuery } from "./runReadList.js";

export function createRunReadHandlers({
  countRuns,
  decorateSingleRun,
  getRun,
  hiddenRunSlugs = [],
  listArtifacts,
  listRunEvents,
  listRunLineage = () => [],
  listRunResponseEndpointsForRun,
  listRuns,
  presentRunResponseEndpoint,
  reapStuckRunsWithRetrospectives,
  runApprovalHold = () => false,
  runDeadlineMs = () => 0,
  runDiagnostics,
  runnerPoolStats,
  runTimelineEnabled,
  subscribeRunEvents,
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

    getRun(req, res) {
      const run = loadRun(req, res);
      if (!run) return;
      res.json(runDetailPayload({
        approvalHold: runApprovalHold(run),
        artifacts: linkedRunArtifacts(run),
        decorateSingleRun,
        events: runEvents(run),
        lineage: listRunLineage(run.id),
        listRunResponseEndpointsForRun,
        presentRunResponseEndpoint,
        run,
        runDiagnostics,
        runnerPoolStats
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
  lineage = [],
  listRunResponseEndpointsForRun,
  presentRunResponseEndpoint,
  run,
  runDiagnostics,
  runnerPoolStats
}) {
  const responseEndpoints = listRunResponseEndpointsForRun(run.id).map(presentRunResponseEndpoint);
  return {
    run: decorateSingleRun(run),
    // True while a human decision is pending on this run (its own approval card
    // or a supervised child in waiting_approval). Runners use this to defer
    // their execution deadline instead of timing the run out under the human.
    approvalHold: Boolean(approvalHold),
    events,
    artifacts,
    // Hub-supervisor self-heal history (run_lineage rows): one entry per
    // resume / repair / escalate / give_up decision, oldest first.
    lineage,
    responseEndpoints,
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
