import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRunResponseEndpointPayload,
  redactResponseEndpointText,
  summarizeResponseOutput
} from "../src/runResponseEndpointPayload.js";

describe("run response endpoint payload helpers", () => {
  it("summarizes output metadata without raw values", () => {
    assert.deepEqual(summarizeResponseOutput(["a", "b"]), {
      kind: "array",
      sizeBytes: 9,
      length: 2
    });
    const summary = summarizeResponseOutput({ ok: true, secret: "shub_secret_value" });
    assert.equal(summary.kind, "object");
    assert.deepEqual(summary.keys, ["ok", "secret"]);
    assert.equal(JSON.stringify(summary).includes("shub_secret_value"), false);
  });

  it("builds terminal payloads with redacted errors, artifact pointers, and links", () => {
    const payload = buildRunResponseEndpointPayload({
      id: "run_1",
      status: "failed",
      currentStep: "deploy",
      capabilitySlug: "hello",
      capabilityName: "Hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:04.000Z",
      error: "Bearer shub_secret_token_value",
      output: { result: "raw value" }
    }, {
      baseUrl: "https://hub.example",
      artifacts: [{ id: "art_1", runId: "run_1", name: "result.md", mimeType: "text/markdown", sizeBytes: 12 }]
    });

    assert.equal(payload.schemaVersion, "runyard.run.response.v1");
    assert.equal(payload.timestamps.durationMs, 3000);
    assert.equal(payload.error.includes("shub_secret"), false);
    assert.equal(payload.output.keys[0], "result");
    assert.equal(payload.artifacts[0].downloadUrl, "https://hub.example/api/artifacts/art_1/download");
    assert.equal(payload.links.logs, "https://hub.example/api/runs/run_1/logs");
  });

  it("includes metered usage and budget on terminal payloads", () => {
    const usage = { totalTokens: 1750, promptTokens: 6, completionTokens: 1744, costMicros: 130890, calls: 1, byModel: {}, byProvider: {} };
    const payload = buildRunResponseEndpointPayload({
      id: "run_2",
      status: "succeeded",
      capabilitySlug: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      usage,
      budget: { maxTokens: 100000 }
    }, {});
    assert.deepEqual(payload.usage, usage);
    assert.deepEqual(payload.budget, { maxTokens: 100000 });
    assert.equal(payload.budgetStop, null);
  });

  it("reports budget stops distinctly with the stop reason and final usage", () => {
    const payload = buildRunResponseEndpointPayload({
      id: "run_3",
      status: "budget_exceeded",
      capabilitySlug: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      error: "budget exceeded: 120 tokens used, budget.maxTokens is 100",
      usage: { totalTokens: 120, costMicros: 0, calls: 2 },
      budget: { maxTokens: 100 }
    }, {});
    assert.equal(payload.status, "budget_exceeded");
    assert.equal(payload.budgetStop.stopped, true);
    assert.match(payload.budgetStop.reason, /budget exceeded: 120 tokens/);
    assert.deepEqual(payload.budgetStop.budget, { maxTokens: 100 });
    assert.equal(payload.usage.totalTokens, 120);
    // Generic-failure error field stays null for budget stops; the reason
    // lives on budgetStop so callers can tell the two apart.
    assert.equal(payload.error, null);
  });

  it("keeps usage null for unmetered runs", () => {
    const payload = buildRunResponseEndpointPayload({
      id: "run_4",
      status: "succeeded",
      capabilitySlug: "hello",
      createdAt: "2026-01-01T00:00:00.000Z"
    }, {});
    assert.equal(payload.usage, null);
    assert.equal(payload.budget, null);
    assert.equal(payload.budgetStop, null);
  });

  it("redacts token-shaped delivery errors", () => {
    assert.equal(redactResponseEndpointText("Bearer abcdefghijk"), "Bearer [redacted]");
    assert.equal(redactResponseEndpointText("x".repeat(502)).length, 500);
  });
});
