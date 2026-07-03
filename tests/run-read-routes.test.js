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
  const lineage = overrides.lineage || [
    { id: "lin_1", runId: "run_1", attempt: 1, action: "resume", reason: "runner offline", fingerprint: "", prevRunnerId: "runner_a", checkpoint: "run-123", createdAt: "2026-01-01T00:00:03.000Z" }
  ];
  const handlers = createRunReadHandlers({
    countRuns: (filters) => {
      calls.countRuns.push(filters);
      return overrides.total ?? runs.length;
    },
    decorateSingleRun: (run) => ({ ...run, single: true }),
    getRun: overrides.getRun || ((id) => runs.find((run) => run.id === id) || null),
    hiddenRunSlugs: ["support-agent"],
    listArtifacts: () => artifacts,
    listRunEvents: () => events,
    listRunLineage: (runId) => lineage.filter((entry) => entry.runId === runId),
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
  return { artifacts, calls, events, handlers, lineage, runs };
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
    assert.deepEqual(payload.lineage, []);
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
    const { handlers, lineage } = harness();
    const res = response();
    handlers.getRun({ params: { id: "run_1" } }, res);

    assert.equal(res.body.run.single, true);
    assert.equal(res.body.artifacts[0].url, "/artifacts/art_1");
    assert.deepEqual(res.body.responseEndpoints[0], { id: "endpoint_1", type: "http", redacted: true });
    assert.equal(res.body.diagnostics.headline, "ok");
    assert.ok(res.body.logSummary);
    assert.deepEqual(res.body.lineage, lineage);
  });

  it("returns an empty self-heal lineage for runs the supervisor never touched", () => {
    const { handlers } = harness();
    const res = response();
    handlers.getRun({ params: { id: "run_2" } }, res);
    assert.deepEqual(res.body.lineage, []);
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

  it("streams run events and unsubscribes when the connection closes", () => {
    const writes = [];
    const callbacks = {};
    let subscribed = null;
    let unsubscribed = false;
    const req = {
      on(event, callback) {
        callbacks[`req:${event}`] = callback;
      }
    };
    const res = {
      headers: null,
      flushed: false,
      set(headers) {
        this.headers = headers;
      },
      flushHeaders() {
        this.flushed = true;
      },
      write(chunk) {
        writes.push(chunk);
      },
      on(event, callback) {
        callbacks[`res:${event}`] = callback;
      }
    };

    streamRunEventsResponse({
      req,
      res,
      run: { id: "run_1" },
      listRunEvents: () => [{ id: "evt_1", createdAt: "2026-01-01T00:00:00.000Z" }],
      subscribeRunEvents: (runId, send) => {
        subscribed = { runId, send };
        return () => { unsubscribed = true; };
      }
    });

    assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
    assert.equal(res.flushed, true);
    assert.match(writes.join(""), /event: ready/);
    assert.equal(subscribed.runId, "run_1");

    subscribed.send({ id: "evt_2", message: "hello" });
    assert.match(writes.join(""), /event: run-event/);

    callbacks["req:close"]();
    callbacks["res:close"]();
    assert.equal(unsubscribed, true);
  });
});
