import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
