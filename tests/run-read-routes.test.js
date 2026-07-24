import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRunReadHandlers,
  runDetailPayload,
  streamRunEventsResponse
} from "../src/runReadRoutes.js";
import { mockResponse as response } from "./response.js";

function harness(overrides = {}) {
  const calls = { countRuns: [], listRuns: [] };
  const runs = overrides.runs || [
    { id: "run_1", createdAt: "2026-01-01T00:00:00.000Z", status: "queued", capabilitySlug: "alpha", input: {} },
    { id: "run_2", createdAt: "2026-01-02T00:00:00.000Z", status: "succeeded", capabilitySlug: "beta", input: {} }
  ];
  const events = overrides.events || [
    { id: "evt_1", createdAt: "2026-01-01T00:00:01.000Z", type: "log", message: "hello shub_Secrettoken123" }
  ];
  const artifacts = overrides.artifacts || [
    { id: "art_1", name: "summary.txt", createdAt: "2026-01-01T00:00:02.000Z" }
  ];
  const handlers = createRunReadHandlers({
    countRuns: (filters) => {
      calls.countRuns.push(filters);
      return overrides.total ?? runs.length;
    },
    getRunUsage: overrides.getRunUsage,
    decorateSingleRun: (run) => ({ ...run, single: true }),
    getRun: overrides.getRun || ((id) => runs.find((run) => run.id === id) || null),
    hiddenRunSlugs: ["support-agent"],
    listArtifacts: () => artifacts,
    listRunEvents: () => events,
    listRunResponseEndpointsForRun: () => [{ id: "endpoint_1", type: "http" }],
    listRuns: (options) => {
      calls.listRuns.push(options);
      if (options.status === "queued") return runs.filter((run) => run.status === "queued");
      if (options.limit === 2) return runs.slice(0, 2);
      return runs;
    },
    presentRunResponseEndpoint: (endpoint) => ({ id: endpoint.id, type: endpoint.type, redacted: true }),
    reapStuckRunsWithRetrospectives: (deadlineMs) => { calls.reapDeadlineMs = deadlineMs; },
    runDeadlineMs: () => 1234,
    runDiagnostics: () => ({ headline: "ok" }),
    runnerPoolStats: () => ({ queued: 1 }),
    runTimelineEnabled: () => overrides.timelineEnabled ?? true,
    subscribeRunEvents: () => () => {},
    withArtifactLinks: (artifact) => ({ ...artifact, url: `/artifacts/${artifact.id}` }),
    withRunLinks: (run, queueIndex) => ({ ...run, queueIndex: queueIndex?.map?.get(run.id) || null, url: `/runs/${run.id}` })
  });
  return { artifacts, calls, events, handlers, runs };
}

describe("run read route helpers", () => {
  it("builds the run detail payload from decorated run data", () => {
    const run = { id: "run_1", status: "failed" };
    const events = [{ id: "evt_1", type: "run.failed", message: "boom", createdAt: "2026-01-01T00:00:00.000Z" }];
    const artifacts = [{ id: "art_1", name: "stderr.log" }];
    const payload = runDetailPayload({
      artifacts,
      decorateSingleRun: (value) => ({ ...value, decorated: true }),
      events,
      listRunResponseEndpointsForRun: (runId) => [{ id: "endpoint_1", runId }],
      presentRunResponseEndpoint: (endpoint) => ({ id: endpoint.id, redacted: true }),
      run,
      runDiagnostics: (value, diagnosticEvents, diagnosticArtifacts) => ({
        runId: value.id,
        eventCount: diagnosticEvents.length,
        artifactCount: diagnosticArtifacts.length
      }),
      runnerPoolStats: () => ({ queued: 2 })
    });

    assert.deepEqual(payload.run, { id: "run_1", status: "failed", decorated: true });
    assert.deepEqual(payload.responseEndpoints, [{ id: "endpoint_1", redacted: true }]);
    assert.deepEqual(payload.diagnostics, { runId: "run_1", eventCount: 1, artifactCount: 1 });
    assert.equal(payload.logSummary.totals.events, 1);
    assert.deepEqual(payload.pool, { queued: 2 });
  });

  it("lists runs with filtered overfetch pagination and queue positions", () => {
    const { calls, handlers } = harness({
      runs: [
        { id: "run_1", createdAt: "2026-01-01T00:00:00.000Z", status: "queued", capabilitySlug: "alpha", input: {} },
        { id: "run_2", createdAt: "2026-01-02T00:00:00.000Z", status: "running", capabilitySlug: "alpha", input: {} },
        { id: "run_3", createdAt: "2026-01-03T00:00:00.000Z", status: "queued", capabilitySlug: "beta", input: {} }
      ],
      total: 3
    });
    const res = response();
    handlers.listRuns({ query: { q: "deploy", workflows: "alpha", limit: "2" } }, res);

    assert.equal(calls.reapDeadlineMs, 1234);
    assert.equal(calls.listRuns[0].limit, 3);
    assert.deepEqual(calls.countRuns[0].capabilitySlugs, ["alpha"]);
    assert.equal(res.body.runs.length, 2);
    assert.equal(res.body.nextCursor, "2026-01-02T00:00:00.000Z");
    assert.deepEqual(res.body.filters.workflows, ["alpha"]);
    assert.equal(res.body.pool.queued, 1);
  });

  it("presents run detail with diagnostics, artifacts, endpoints, and log summary", () => {
    const { handlers } = harness();
    const res = response();
    handlers.getRun({ params: { id: "run_1" } }, res);

    assert.equal(res.body.run.single, true);
    assert.equal(res.body.artifacts[0].url, "/artifacts/art_1");
    assert.deepEqual(res.body.responseEndpoints[0], { id: "endpoint_1", type: "http", redacted: true });
    assert.equal(res.body.diagnostics.headline, "ok");
    assert.ok(res.body.logSummary);
  });

  it("serves redacted text logs and gated timelines", () => {
    const enabled = harness();
    const logsRes = response();
    enabled.handlers.getRunLogs({ params: { id: "run_1" } }, logsRes);
    assert.equal(logsRes.typeValue, "text/plain");
    assert.match(logsRes.body, /\[redacted\]/);

    const timelineRes = response();
    enabled.handlers.getRunTimeline({ params: { id: "run_1" }, query: { limit: "5" } }, timelineRes);
    assert.equal(timelineRes.body.runId, "run_1");
    assert.ok(Array.isArray(timelineRes.body.entries));

    const disabled = harness({ timelineEnabled: false });
    const disabledRes = response();
    disabled.handlers.getRunTimeline({ params: { id: "run_1" }, query: {} }, disabledRes);
    assert.equal(disabledRes.statusCode, 404);
  });

  it("serves run usage with budget-stop presentation", () => {
    const usage = { totalTokens: 120, costMicros: 900, calls: 2, byModel: {} };
    const { handlers } = harness({
      runs: [{
        id: "run_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "budget_exceeded",
        capabilitySlug: "alpha",
        input: {},
        error: "budget exceeded: 120 tokens used, budget.maxTokens is 100",
        budget: { maxTokens: 100 }
      }],
      getRunUsage: (id) => ({ runId: id, usage, budget: { maxTokens: 100 }, records: [{ id: "usg_1" }] })
    });
    const res = response();
    handlers.getRunUsage({ params: { id: "run_1" } }, res);
    assert.equal(res.body.runId, "run_1");
    assert.deepEqual(res.body.usage, usage);
    assert.equal(res.body.records.length, 1);
    assert.equal(res.body.status, "budget_exceeded");
    assert.equal(res.body.budgetStop.stopped, true);
    assert.match(res.body.budgetStop.reason, /budget exceeded/);

    const missing = harness({ getRunUsage: () => null });
    const notFound = response();
    missing.handlers.getRunUsage({ params: { id: "run_missing" } }, notFound);
    assert.equal(notFound.statusCode, 404);
  });

  it("streams run events with seq ids, replays after the cursor, and drains to close at terminal", async () => {
    const events = [
      { id: "evt_0", runId: "run_1", type: "run.created", message: "queued", data: {}, seq: 0, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "evt_1", runId: "run_1", type: "log", message: "hello", data: {}, seq: 1, createdAt: "2026-01-01T00:00:01.000Z" }
    ];
    let status = "running";
    const writes = [];
    const callbacks = {};
    let unsubscribed = false;
    const req = { query: { afterSeq: "0" }, headers: {}, on(event, callback) { callbacks[`req:${event}`] = callback; } };
    const res = {
      headers: null,
      flushed: false,
      writableEnded: false,
      set(headers) { this.headers = headers; },
      flushHeaders() { this.flushed = true; },
      write(chunk) { writes.push(chunk); return true; },
      end() { this.writableEnded = true; },
      on(event, callback) { callbacks[`res:${event}`] = callback; },
      once(event, callback) { callbacks[`res:once:${event}`] = callback; }
    };

    streamRunEventsResponse({
      req,
      res,
      run: { id: "run_1" },
      getRun: () => ({ id: "run_1", status }),
      listRunEventsAfter: (runId, afterSeq, limit) =>
        events.filter((event) => event.seq > afterSeq).slice(0, limit),
      subscribeRunEvents: () => () => { unsubscribed = true; },
      limits: { batchLimit: 200, pollMs: 5, heartbeatMs: 10_000, retryMs: 1000, drainTimeoutMs: 1000, maxTails: 10, maxTailsPerRun: 10 }
    });

    assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
    assert.equal(res.flushed, true);

    // Replay is cursor-driven: afterSeq=0 must deliver evt_1 only.
    await new Promise((resolve) => setTimeout(resolve, 20));
    let output = writes.join("");
    assert.match(output, /retry: 1000/);
    assert.match(output, /event: ready/);
    assert.match(output, /id: 1\nevent: run-event/);
    assert.ok(!output.includes('"seq":0'), "cursor replay must skip seq 0");

    // A late event is picked up, then terminal status drains and closes.
    events.push({ id: "evt_2", runId: "run_1", type: "log", message: "late", data: {}, seq: 2, createdAt: "2026-01-01T00:00:02.000Z" });
    status = "succeeded";
    await new Promise((resolve) => setTimeout(resolve, 40));
    output = writes.join("");
    assert.match(output, /id: 2\nevent: run-event/);
    assert.match(output, /event: run-terminal/);
    assert.match(output, /"status":"succeeded"/);
    assert.equal(res.writableEnded, true);
    assert.equal(unsubscribed, true);
  });

  it("sends keepalive comments while live and stops cleanly on client disconnect", async () => {
    const writes = [];
    const callbacks = {};
    let unsubscribed = false;
    const req = { query: {}, headers: {}, on(event, callback) { callbacks[`req:${event}`] = callback; } };
    const res = {
      writableEnded: false,
      set() {},
      flushHeaders() {},
      write(chunk) { writes.push(chunk); return true; },
      end() { this.writableEnded = true; },
      on(event, callback) { callbacks[`res:${event}`] = callback; },
      once() {}
    };
    streamRunEventsResponse({
      req,
      res,
      run: { id: "run_hb" },
      getRun: () => ({ id: "run_hb", status: "running" }),
      listRunEventsAfter: () => [],
      subscribeRunEvents: () => () => { unsubscribed = true; },
      limits: { batchLimit: 200, pollMs: 5, heartbeatMs: 15, retryMs: 1000, drainTimeoutMs: 1000, maxTails: 10, maxTailsPerRun: 10 }
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(writes.filter((chunk) => chunk.includes(": ping")).length >= 1, "keepalive comments while idle");
    assert.equal(res.writableEnded, false, "live run stays open");
    callbacks["req:close"]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unsubscribed, true, "disconnect cleanup unsubscribes the wake listener");
  });

  it("pauses reads on backpressure and disconnects a consumer that never drains", async () => {
    const events = Array.from({ length: 3 }, (_, seq) => ({
      id: `evt_${seq}`, runId: "run_bp", type: "log", message: "x", data: {}, seq, createdAt: "2026-01-01T00:00:00.000Z"
    }));
    const writes = [];
    let destroyed = false;
    const drains = [];
    const req = { query: {}, headers: {}, on() {} };
    const res = {
      writableEnded: false,
      set() {},
      flushHeaders() {},
      // Signal a clogged socket as soon as the first event frame is written.
      write(chunk) { writes.push(chunk); return !chunk.includes("run-event"); },
      end() { this.writableEnded = true; },
      destroy() { destroyed = true; this.writableEnded = true; },
      on() {},
      off() {},
      once(event, callback) { if (event === "drain") drains.push(callback); }
    };
    streamRunEventsResponse({
      req,
      res,
      run: { id: "run_bp" },
      getRun: () => ({ id: "run_bp", status: "running" }),
      listRunEventsAfter: (runId, afterSeq, limit) => events.filter((event) => event.seq > afterSeq).slice(0, limit),
      subscribeRunEvents: () => () => {},
      limits: { batchLimit: 200, pollMs: 5, heartbeatMs: 10_000, retryMs: 1000, drainTimeoutMs: 30, maxTails: 10, maxTailsPerRun: 10 }
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const sentEvents = writes.filter((chunk) => chunk.includes("run-event")).length;
    assert.equal(sentEvents, 1, "no further reads/writes while waiting for drain");
    assert.equal(drains.length, 1, "waiting on the drain event");
    // Never drains -> the slow consumer is disconnected at drainTimeoutMs.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(destroyed, true, "clogged consumer disconnected; memory stays bounded");
  });

  it("rejects invalid cursors and enforces subscriber caps before opening the stream", () => {
    const base = {
      run: { id: "run_1" },
      getRun: () => ({ id: "run_1", status: "running" }),
      listRunEventsAfter: () => [],
      subscribeRunEvents: () => () => {}
    };
    const invalid = response();
    streamRunEventsResponse({
      ...base,
      req: { query: { afterSeq: "banana" }, headers: {} },
      res: invalid
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body.error, /invalid event cursor/);

    const capped = response();
    streamRunEventsResponse({
      ...base,
      req: { query: {}, headers: {} },
      res: capped,
      totalSubscriberCount: () => 10_000
    });
    assert.equal(capped.statusCode, 429);

    const runCapped = response();
    streamRunEventsResponse({
      ...base,
      req: { query: {}, headers: {} },
      res: runCapped,
      subscriberCount: () => 10_000
    });
    assert.equal(runCapped.statusCode, 429);
  });
});
