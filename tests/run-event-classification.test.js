import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  eventCategory,
  eventNode,
  eventSeverity,
  eventTypeLabel,
  isFocusEvent,
  isLogEvent,
  sortCategoryEntries
} from "../src/runEventClassification.js";

describe("run event classification helpers", () => {
  it("classifies focus and log events", () => {
    assert.equal(isFocusEvent({ type: "run.failed" }), true);
    assert.equal(isFocusEvent({ type: "runner.heartbeat" }), false);
    assert.equal(isLogEvent({ type: "runner.log" }), true);
    assert.equal(isLogEvent({ type: "custom.stderr" }), true);
  });

  it("classifies categories and severities", () => {
    assert.equal(eventCategory({ type: "runner.heartbeat" }), "noise");
    assert.equal(eventCategory({ type: "claude.tool_use" }), "noise");
    assert.equal(eventCategory({ type: "approval.requested" }), "approval");
    assert.equal(eventCategory({ type: "run.chain.next" }), "run");
    assert.equal(eventCategory({ type: "node.skipped" }), "node");
    assert.equal(eventCategory({ type: "workflow.step" }), "step");
    assert.equal(eventCategory({ type: "agent.summary" }), "agent");
    assert.equal(eventCategory({ type: "stderr" }), "log");
    assert.equal(eventCategory({ type: "custom" }), "other");

    assert.equal(eventSeverity({ type: "node.failed" }), "error");
    assert.equal(eventSeverity({ type: "stderr" }), "error");
    assert.equal(eventSeverity({ type: "node.skipped" }), "warn");
    assert.equal(eventSeverity({ type: "log", message: "warning: retrying" }), "warn");
    assert.equal(eventSeverity({ type: "log", message: "ok" }), "info");
  });

  it("extracts node ids and sorts category entries", () => {
    assert.equal(eventNode({ type: "node.started", data: { nodeId: "build" } }), "build");
    assert.equal(eventNode({ type: "task.failed", data: { id: "task-1" } }), "task-1");
    assert.equal(eventNode({ type: "custom", data: {} }), "");
    assert.equal(eventTypeLabel(""), "log");

    assert.deepEqual(sortCategoryEntries([
      { key: "noise" },
      { key: "run" },
      { key: "agent" }
    ]).map((entry) => entry.key), ["run", "agent", "noise"]);
  });
});
