import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFollowerLineHandler,
  smithersEventMessage,
  smithersEventsArtifactContent,
  stripAnsi
} from "../src/runnerSmithersEvents.js";

describe("runner Smithers event helpers", () => {
  it("strips ANSI control sequences from event text", () => {
    assert.equal(stripAnsi("\x1B[31mfailed\x1B[0m"), "failed");
  });

  it("normalizes JSON and raw Smithers event lines", () => {
    assert.equal(smithersEventMessage('{"data":"step ok"}'), "step ok");
    assert.equal(smithersEventMessage('{"message":"fallback message"}'), "fallback message");
    assert.equal(smithersEventMessage("\x1B[33mraw warning\x1B[0m"), "raw warning");
  });

  it("builds sanitized Smithers event artifact content", () => {
    assert.equal(
      smithersEventsArtifactContent([
        '{"data":"first"}',
        "\x1B[31msecond\x1B[0m"
      ]),
      "first\nsecond"
    );
  });
});

describe("follower line handler", () => {
  const usageLine = JSON.stringify({
    runId: "run-eng",
    seq: 7,
    type: "TokenUsageReported",
    payload: {
      type: "TokenUsageReported",
      model: "gpt-5.2",
      inputTokens: 100,
      outputTokens: 50,
      nodeId: "n1"
    }
  });

  function harness(gatewayModel = "") {
    const seen = { observed: [], events: [], usage: [] };
    const handle = createFollowerLineHandler({
      observeEventLine: (line) => seen.observed.push(line),
      postEvent: async (message) => seen.events.push(message),
      postUsage: async (usage) => seen.usage.push(usage),
      gatewayModel
    });
    return { handle, seen };
  }

  it("observes approvals, posts the normalized event message, and reports usage", async () => {
    const { handle, seen } = harness();
    await handle(usageLine);
    assert.deepEqual(seen.observed, [usageLine]);
    assert.equal(seen.events.length, 1);
    assert.equal(seen.usage.length, 1);
    assert.equal(seen.usage[0].model, "gpt-5.2");
    assert.equal(seen.usage[0].requestId, "run-eng:7");
  });

  it("skips usage for the gateway-metered model so nothing double-counts", async () => {
    const { handle, seen } = harness("gpt-5.2");
    await handle(usageLine);
    assert.equal(seen.events.length, 1, "event still posted");
    assert.equal(seen.usage.length, 0, "gateway-metered model excluded");
  });

  it("posts plain event lines without usage records", async () => {
    const { handle, seen } = harness();
    await handle('{"runId":"run-eng","seq":8,"type":"NodeStarted","payload":{"data":"step ok"}}');
    assert.equal(seen.events.length, 1);
    assert.equal(seen.usage.length, 0);
  });
});
