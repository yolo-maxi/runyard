import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  eventCategory,
  eventNode,
  eventSeverity,
  isLogEvent,
  redactSnippet,
  summarizeRunEvents
} from "../src/runEventSummary.js";

describe("run event summary helpers", () => {
  it("classifies event category, severity, and node consistently", () => {
    const event = {
      type: "node.failed",
      message: "build failed with timeout",
      data: { nodeId: "build-step" }
    };
    assert.equal(eventCategory(event), "node");
    assert.equal(eventSeverity(event), "error");
    assert.equal(eventNode(event), "build-step");
    assert.equal(isLogEvent({ type: "runner.log" }), true);
  });

  it("redacts token-shaped log snippets before exposing them", () => {
    const text = redactSnippet("authorization: Bearer shub_abc123 and token=sk-1234567890abcdef");
    assert.doesNotMatch(text, /shub_abc123/);
    assert.doesNotMatch(text, /sk-1234567890abcdef/);
    assert.match(text, /\[redacted\]/);
  });

  it("summarizes counts, highlights, types, and noisy defaults", () => {
    const events = [
      { id: "1", type: "runner.heartbeat", message: "tick", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "2", type: "workflow.step", message: "build", createdAt: "2026-01-01T00:00:01.000Z", data: { step: "build" } },
      { id: "3", type: "stderr", message: "error: token=ghp_123456789012345678901", createdAt: "2026-01-01T00:00:02.000Z" },
      { id: "4", type: "run.failed", message: "failed", createdAt: "2026-01-01T00:00:03.000Z" }
    ];

    const summary = summarizeRunEvents(events);
    assert.deepEqual(summary.totals, { events: 4, highlights: 3, errors: 2, warnings: 0 });
    assert.ok(summary.categories.find((entry) => entry.key === "noise" && entry.collapsedByDefault));
    assert.ok(summary.categories.find((entry) => entry.key === "run"));
    assert.ok(summary.types.find((entry) => entry.key === "run.failed" && entry.category === "run"));
    assert.ok(summary.nodes.find((entry) => entry.node === "build"));
    assert.ok(summary.highlights.every((entry) => entry.category !== "noise"));
    assert.doesNotMatch(summary.highlights.map((entry) => entry.message).join("\n"), /ghp_123456789012345678901/);
  });
});
