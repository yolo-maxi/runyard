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

  it("redacts token-shaped delivery errors", () => {
    assert.equal(redactResponseEndpointText("Bearer abcdefghijk"), "Bearer [redacted]");
    assert.equal(redactResponseEndpointText("x".repeat(502)).length, 500);
  });
});
