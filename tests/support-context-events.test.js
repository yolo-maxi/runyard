import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSupportContextEvent,
  summarizeSupportEvents
} from "../src/supportContextEvents.js";

describe("support context event helpers", () => {
  it("keeps lifecycle and failure events while dropping noisy telemetry", () => {
    assert.equal(isSupportContextEvent({ type: "runner.heartbeat", message: "tick" }), false);
    assert.equal(isSupportContextEvent({ type: "node.failed", message: "failed" }), true);
    assert.equal(isSupportContextEvent({ type: "log", message: "warning: timeout soon" }), true);
  });

  it("summarizes focused events and redacts event messages", () => {
    const events = [
      { type: "runner.heartbeat", message: "tick", createdAt: "1" },
      { type: "node.failed", message: "token=sk-abc123def456ghi789", createdAt: "2" },
      { type: "run.failed", message: "failed", createdAt: "3" }
    ];

    assert.deepEqual(summarizeSupportEvents(events, { max: 1 }), [
      { type: "run.failed", message: "failed", at: "3" }
    ]);
    const summary = summarizeSupportEvents(events);
    assert.equal(summary.length, 2);
    assert.doesNotMatch(summary[0].message, /sk-abc123/);
    assert.match(summary[0].message, /\[redacted\]/);
  });

  it("falls back to recent raw events when none match focus rules", () => {
    assert.deepEqual(summarizeSupportEvents([
      { type: "custom", message: "one", createdAt: "1" },
      { type: "other", message: "two", createdAt: "2" }
    ], { max: 1 }), [
      { type: "other", message: "two", at: "2" }
    ]);
  });
});
