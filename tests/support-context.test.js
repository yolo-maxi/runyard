import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated DB so we can seed runs/events and assert the live-context block the
// support agent receives is real, redacted, and bounded.
const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-ctx-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "ctx.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";

const { addRunEvent, createRun, getCapability, transitionRun } = await import("../src/db.js");
const { buildSupportLiveContext, __test } = await import("../src/supportContext.js");

describe("support agent live context", () => {
  let failedRunId;

  before(() => {
    const hello = getCapability("hello");
    assert.ok(hello, "expected seeded 'hello' capability");
    const run = createRun(hello, {
      goal: "Ship the widget",
      // Secret-shaped fields must never appear in the context block.
      apiKey: "sk-supersecretvalue1234567890",
      token: "shub_abcdefghijklmnop"
    });
    failedRunId = run.id;
    transitionRun(run.id, "running", { current_step: "build" });
    addRunEvent(run.id, "node.failed", "Build failed: TypeError at line 42", { node: "build" });
    addRunEvent(run.id, "run.failed", "Run failed during build", {});
    addRunEvent(run.id, "runner.heartbeat", "tick", {}); // noise, should be filtered
    transitionRun(run.id, "failed", { current_step: "build", error: "TypeError: cannot read x of undefined" });
  });

  it("resolves a run-detail route into real run + event data", () => {
    const ctx = buildSupportLiveContext({ hash: `#runs/${failedRunId}`, view: "runs" });
    assert.equal(ctx.kind, "run");
    assert.match(ctx.text, new RegExp(failedRunId));
    assert.match(ctx.text, /Status: failed/);
    assert.match(ctx.text, /TypeError/);
    assert.match(ctx.text, /Build failed/);
    assert.match(ctx.text, /goal=Ship the widget/);
  });

  it("never leaks secret-shaped input values into the context block", () => {
    const ctx = buildSupportLiveContext({ hash: `#runs/${failedRunId}` });
    assert.doesNotMatch(ctx.text, /sk-supersecretvalue/);
    assert.doesNotMatch(ctx.text, /shub_abcdefghijklmnop/);
    assert.doesNotMatch(ctx.text, /apiKey=/);
  });

  it("filters noisy heartbeat events from the recent-events list", () => {
    const events = __test.recentRunEvents(failedRunId);
    assert.ok(events.length > 0);
    assert.ok(!events.some((e) => e.type === "runner.heartbeat"), "heartbeat should be filtered");
    assert.ok(events.some((e) => /failed/i.test(e.type)));
  });

  it("summarizes the runs list with counts and failing runs on the home route", () => {
    const ctx = buildSupportLiveContext({ hash: "#runs", view: "runs" });
    assert.equal(ctx.kind, "runs");
    assert.match(ctx.text, /Runs overview/);
    assert.match(ctx.text, /Runner pool/);
    assert.match(ctx.text, new RegExp(failedRunId)); // failed run is surfaced
  });

  it("describes a workflow when on a workflow detail route", () => {
    const ctx = buildSupportLiveContext({ hash: "#workflows/hello", view: "workflows" });
    assert.equal(ctx.kind, "workflow");
    assert.match(ctx.text, /hello/);
  });

  it("reports a missing run gracefully instead of throwing", () => {
    const ctx = buildSupportLiveContext({ hash: "#runs/run_does_not_exist" });
    assert.equal(ctx.kind, "run-missing");
    assert.match(ctx.text, /not found/);
  });

  it("redacts bearer-token shapes from event text", () => {
    const redacted = __test.redact("authorization: Bearer sk-abc123def456ghi789 done");
    assert.doesNotMatch(redacted, /sk-abc123def456/);
    assert.match(redacted, /\[redacted\]/);
  });

  it("returns an empty block for routes with no extra data", () => {
    const ctx = buildSupportLiveContext({ hash: "#audit", view: "audit" });
    assert.equal(ctx.text, "");
  });
});

after(() => {});
