import { buildRunFlow } from "./runFlow.js";
import { RUN_TERMINAL } from "./runLifecyclePolicy.js";
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
  listRunEventsAfter,
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
  sseSubscriberCount = () => 0,
  sseTotalSubscriberCount = () => 0,
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
      streamRunEventsResponse({
        req,
        res,
        run,
        getRun,
        listRunEventsAfter,
        subscribeRunEvents,
        subscriberCount: sseSubscriberCount,
        totalSubscriberCount: sseTotalSubscriberCount
      });
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

// --- Live run-event stream ---------------------------------------------------
// Mirrors the Smithers server's SSE route (@smithers-orchestrator/server
// /v1/runs/:runId/events): a bounded poll loop over PERSISTED events with a
// per-run seq cursor, so replay, live tail, reconnect resume, and Hub-restart
// recovery are all the same code path and an attach/backfill race cannot lose
// events (the DB is the only source; the in-process bus is just a wake-up
// signal that cuts tail latency below the poll interval).
//
// Deliberate deviations from Smithers, documented in
// specs/cli-stream-follow.md:
//   - frames carry `id: <seq>` and honor Last-Event-ID (standard SSE resume;
//     Smithers only reads ?afterSeq),
//   - the named event stays `run-event` and the `ready` preamble is kept for
//     the existing web console,
//   - a final `run-terminal` frame announces the run's terminal status before
//     the drain-then-close (Smithers clients infer this from engine events),
//   - slow consumers are bounded: writes pause on backpressure and a consumer
//     that stays clogged past drainTimeoutMs is disconnected (the Smithers
//     gateway's queue-cap disconnect, adapted to HTTP SSE),
//   - global and per-run tail caps return 429 before the stream opens (the
//     gateway's global connection cap, plus a per-run bound).

export const SSE_DEFAULTS = {
  batchLimit: 200, // Smithers server page size per poll
  pollMs: 500, // Smithers server poll cadence
  heartbeatMs: 10_000, // Smithers DEFAULT_SSE_HEARTBEAT_MS
  retryMs: 1000, // Smithers `retry:` hint
  drainTimeoutMs: 30_000,
  maxTails: 256,
  maxTailsPerRun: 32
};

export function sseStreamLimits(env = process.env) {
  const positive = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  return {
    ...SSE_DEFAULTS,
    maxTails: positive(env.RUNYARD_SSE_MAX_TAILS, SSE_DEFAULTS.maxTails),
    maxTailsPerRun: positive(env.RUNYARD_SSE_MAX_TAILS_PER_RUN, SSE_DEFAULTS.maxTailsPerRun)
  };
}

// Cursor from ?afterSeq or the standard Last-Event-ID reconnect header
// (query param wins for the replay position). `headerSeq` is reported
// separately whenever the reconnect header is present — an EventSource
// always resends it on auto-reconnect, even when the page also baked an
// ?afterSeq into the URL — so the 204 terminal-reconnect answer can key on
// what the client actually received. Invalid cursors 400 before the stream.
export function parseStreamCursor({ query = {}, headers = {} } = {}) {
  const parseSeq = (raw) => {
    const trimmed = String(raw).trim();
    // Plain base-10 integers only — no exponent/hex forms via Number coercion.
    const parsed = /^-?\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    return Number.isInteger(parsed) && parsed >= -1 ? parsed : null;
  };
  const headerRaw = headers["last-event-id"];
  let headerSeq = null;
  if (headerRaw !== undefined && headerRaw !== null && headerRaw !== "") {
    headerSeq = parseSeq(headerRaw);
    if (headerSeq === null) return { error: `invalid event cursor: ${String(headerRaw).trim().slice(0, 100)}` };
  }
  const fromQuery = query.afterSeq !== undefined && query.afterSeq !== "";
  if (!fromQuery) return { afterSeq: headerSeq ?? -1, headerSeq };
  const querySeq = parseSeq(query.afterSeq);
  if (querySeq === null) return { error: `invalid event cursor: ${String(query.afterSeq).trim().slice(0, 100)}` };
  return { afterSeq: querySeq, headerSeq };
}

export function streamRunEventsResponse({
  req,
  res,
  run,
  getRun,
  listRunEventsAfter,
  subscribeRunEvents,
  subscriberCount = () => 0,
  totalSubscriberCount = () => 0,
  isTerminalStatus = (status) => RUN_TERMINAL.has(status),
  limits = sseStreamLimits()
}) {
  const cursor = parseStreamCursor({ query: req.query, headers: req.headers });
  if (cursor.error) {
    res.status(400).json({ error: cursor.error });
    return;
  }
  // A browser EventSource auto-reconnects after ANY close — including the
  // deliberate terminal drain-then-close — and only an HTTP 204 stops it.
  // When a reconnect (Last-Event-ID header, which the CLI never sends — it
  // resumes via ?afterSeq) arrives on a terminal run and the client already
  // received everything up to its header cursor, answer 204 so EventSource
  // consumers (with or without an ?afterSeq baked into their URL) cannot
  // reconnect-loop against finished runs.
  if (cursor.headerSeq !== null
    && isTerminalStatus(run.status)
    && listRunEventsAfter(run.id, cursor.headerSeq, 1).length === 0) {
    res.status(204).end();
    return;
  }
  if (totalSubscriberCount() >= limits.maxTails) {
    res.status(429).json({ error: "too many live event streams open on this hub" });
    return;
  }
  if (subscriberCount(run.id) >= limits.maxTailsPerRun) {
    res.status(429).json({ error: "too many live event streams open for this run" });
    return;
  }

  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();

  let closed = false;
  let lastSeq = cursor.afterSeq;
  // Wake-up plumbing: the bus listener resolves the current poll sleep so a
  // freshly persisted event reaches open tails immediately. All event DATA
  // still comes from the DB in seq order — the signal carries no payload, so
  // there is nothing to buffer and no attach race to lose.
  let wake = null;
  const wakeNow = () => {
    if (!wake) return;
    const resolve = wake;
    wake = null;
    resolve();
  };
  const unsubscribe = subscribeRunEvents(run.id, wakeNow);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    wakeNow();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);

  const write = (chunk) => {
    if (closed || res.writableEnded) return true;
    try {
      return res.write(chunk);
    } catch {
      cleanup();
      return true;
    }
  };

  // Backpressure: when the socket buffer is full, stop reading from the DB
  // until it drains. A consumer that stays clogged past drainTimeoutMs is
  // disconnected — memory stays bounded at one batch either way.
  const drained = () => new Promise((resolve) => {
    if (closed || res.writableEnded) return resolve();
    const finish = () => {
      clearTimeout(timer);
      res.off("drain", finish);
      res.off("close", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      res.off("drain", finish);
      res.off("close", finish);
      try { res.destroy(); } catch { /* already gone */ }
      cleanup();
      resolve();
    }, limits.drainTimeoutMs);
    res.once("drain", finish);
    // A disconnect mid-backpressure must release the wait immediately, not
    // after drainTimeoutMs.
    res.once("close", finish);
  });

  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
    if (closed) wakeNow();
  });

  write(`retry: ${limits.retryMs}\n\n`);
  write(": connected\n\n");

  (async () => {
    // `ready` preamble kept for the existing web console (it stops its
    // fallback poll on this event). lastSeq/afterSeq are additive fields.
    const readyTail = latestRunEventCursor(listRunEventsAfter, run.id);
    write(`event: ready\ndata: ${JSON.stringify({
      runId: run.id,
      lastEventId: readyTail.lastEventId,
      count: readyTail.count,
      lastSeq: readyTail.lastSeq,
      afterSeq: cursor.afterSeq
    })}\n\n`);

    let lastHeartbeat = Date.now();
    try {
      while (!closed && !res.writableEnded) {
        // Drain everything past the cursor in bounded batches.
        let caughtUp = false;
        while (!closed && !res.writableEnded) {
          const events = listRunEventsAfter(run.id, lastSeq, limits.batchLimit);
          for (const event of events) {
            if (typeof event.seq === "number") lastSeq = event.seq;
            if (closed || res.writableEnded) break;
            const ok = write(`id: ${event.seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`);
            if (!ok) await drained();
          }
          if (events.length < limits.batchLimit) {
            caughtUp = true;
            break;
          }
        }
        if (closed || res.writableEnded) break;
        const now = Date.now();
        if (now - lastHeartbeat >= limits.heartbeatMs) {
          write(": ping\n\n");
          lastHeartbeat = now;
        }
        // Terminal drain-then-close, exactly like the Smithers server: end
        // only once the run is terminal AND the cursor has caught up. The
        // caught-up check is re-queried HERE (not reused from the batch loop)
        // because a backpressure drain-wait inside the batch loop yields the
        // event loop — events persisted during that wait must not be dropped
        // by trusting a stale emptiness result. Status is read before the
        // emptiness probe: terminal is absorbing, so this ordering can never
        // close early.
        const current = getRun(run.id);
        if (caughtUp
          && (!current || isTerminalStatus(current.status))
          && listRunEventsAfter(run.id, lastSeq, 1).length === 0) {
          write(`event: run-terminal\ndata: ${JSON.stringify({
            runId: run.id,
            status: current ? current.status : "deleted",
            lastSeq
          })}\n\n`);
          break;
        }
        await sleep(limits.pollMs);
      }
    } catch {
      // Fall through to cleanup; the consumer sees the socket close and
      // reconnects with Last-Event-ID.
    } finally {
      cleanup();
      if (!res.writableEnded) {
        try { res.end(); } catch { /* already gone */ }
      }
    }
  })();
}

// Cheap tail snapshot for the `ready` preamble: last event id/seq + total
// count without materializing the whole history.
function latestRunEventCursor(listRunEventsAfter, runId) {
  // Walk in pages only to count; runs are short (hundreds of events), and this
  // happens once per attach.
  let count = 0;
  let lastEventId = null;
  let lastSeq = -1;
  let cursor = -1;
  while (true) {
    const page = listRunEventsAfter(runId, cursor, 1000);
    if (!page.length) break;
    count += page.length;
    const last = page[page.length - 1];
    lastEventId = last.id;
    lastSeq = typeof last.seq === "number" ? last.seq : lastSeq;
    cursor = lastSeq;
    if (page.length < 1000) break;
  }
  return { count, lastEventId, lastSeq };
}
