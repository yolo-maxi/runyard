import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonApiClient } from "./http-client.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-budget-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";

const { app } = await import("../src/server.js");

let server;
let baseUrl;
const api = createJsonApiClient({ baseUrl: () => baseUrl, token: "shub_test_token" });

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("run budgets end-to-end", () => {
  it("rejects malformed budgets with a clean 400 before creating anything", async () => {
    await assert.rejects(
      api("/api/capabilities/hello/run", {
        method: "POST",
        body: { input: { goal: "capped" }, budget: { maxTokens: -5 } }
      }),
      (error) => {
        assert.equal(error.message, "budget_invalid");
        return true;
      }
    );
    // The status code itself: raw fetch without the throwing client.
    const raw = await fetch(`${baseUrl}/api/capabilities/hello/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer shub_test_token" },
      body: JSON.stringify({ input: { goal: "capped" }, budget: { maxTokens: "lots" } })
    });
    assert.equal(raw.status, 400);
    const body = await raw.json();
    assert.equal(body.error, "budget_invalid");
    assert.match(body.issues[0], /budget\.maxTokens/);
  });

  it("persists the budget, exposes it on status, and hard-stops the run on breach", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "capped run" }, budget: { maxTokens: 100 } }
    });
    const runId = created.run.id;
    assert.deepEqual(created.run.budget, { maxTokens: 100 });

    await api(`/api/runs/${runId}/start`, { method: "POST", body: {} });

    // First call stays under budget: recorded, not stopped.
    const under = await api(`/api/runs/${runId}/usage`, {
      method: "POST",
      body: { model: "m", promptTokens: 40, completionTokens: 10, source: "runner", requestId: "sid:1" }
    });
    assert.equal(under.budget.exceeded, false);
    assert.equal((await api(`/api/runs/${runId}`)).run.status, "running");

    // Second call breaches maxTokens: the ingest response reports the stop and
    // the run transitions to the distinct budget_exceeded terminal status.
    const breach = await api(`/api/runs/${runId}/usage`, {
      method: "POST",
      body: { model: "m", promptTokens: 60, completionTokens: 10, source: "runner", requestId: "sid:2" }
    });
    assert.equal(breach.budget.exceeded, true);
    assert.equal(breach.budget.stopped, true);
    assert.match(breach.budget.reason, /budget exceeded: 120 tokens used, budget\.maxTokens is 100/);

    const detail = await api(`/api/runs/${runId}`);
    assert.equal(detail.run.status, "budget_exceeded");
    assert.match(detail.run.error, /budget exceeded/);
    assert.equal(detail.run.usage.totalTokens, 120);
    assert.ok(detail.run.completedAt);

    const eventTypes = detail.events.map((event) => event.type);
    assert.ok(eventTypes.includes("run.usage"));
    assert.ok(eventTypes.includes("run.budget.exceeded"));

    const usagePayload = await api(`/api/runs/${runId}/usage`);
    assert.equal(usagePayload.status, "budget_exceeded");
    assert.equal(usagePayload.budgetStop.stopped, true);
    assert.deepEqual(usagePayload.budgetStop.budget, { maxTokens: 100 });
    assert.equal(usagePayload.records.length, 2);

    // Late usage reports after the stop are still recorded (they already
    // happened) but never re-trigger the breach event.
    const late = await api(`/api/runs/${runId}/usage`, {
      method: "POST",
      body: { model: "m", promptTokens: 5, completionTokens: 1, source: "runner", requestId: "sid:3" }
    });
    assert.equal(late.budget.exceeded, true);
    assert.equal(late.budget.stopped, undefined);
    const events = (await api(`/api/runs/${runId}`)).events;
    assert.equal(events.filter((event) => event.type === "run.budget.exceeded").length, 1);
  });

  it("enforces maxCostMicros with estimated pricing", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      // claude-opus-4-7: 100 prompt + 20 completion = 1500 + 1500 = 3000 micros.
      body: { input: { goal: "cost capped", budget: { maxCostMicros: 2000 } } }
    });
    const runId = created.run.id;
    assert.deepEqual(created.run.budget, { maxCostMicros: 2000 });
    await api(`/api/runs/${runId}/start`, { method: "POST", body: {} });

    const breach = await api(`/api/runs/${runId}/usage`, {
      method: "POST",
      body: { model: "claude-opus-4-7", promptTokens: 100, completionTokens: 20, source: "runner" }
    });
    assert.equal(breach.budget.exceeded, true);
    assert.equal(breach.budget.stopped, true);
    assert.match(breach.budget.reason, /budget\.maxCostMicros is 2000/);
    assert.equal((await api(`/api/runs/${runId}`)).run.status, "budget_exceeded");
  });

  it("keeps duplicate usage replays from double counting toward the budget", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "replay safe" }, budget: { maxTokens: 100 } }
    });
    const runId = created.run.id;
    await api(`/api/runs/${runId}/start`, { method: "POST", body: {} });

    const body = { model: "m", promptTokens: 60, completionTokens: 0, source: "runner", requestId: "sid:replay" };
    await api(`/api/runs/${runId}/usage`, { method: "POST", body });
    const replay = await api(`/api/runs/${runId}/usage`, { method: "POST", body });
    assert.equal(replay.duplicate, true);
    const detail = await api(`/api/runs/${runId}`);
    assert.equal(detail.run.usage.totalTokens, 60);
    assert.equal(detail.run.status, "running");
  });
});
