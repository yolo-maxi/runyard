import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSupportRoute,
  redactContextValue,
  safeSupportInput
} from "../src/supportContextPresentation.js";

describe("support context presentation helpers", () => {
  it("parses route hashes and normalizes view aliases", () => {
    assert.deepEqual(parseSupportRoute({ hash: "#runs/run_1", view: "dashboard" }), {
      view: "runs",
      segments: ["runs", "run_1"],
      hash: "runs/run_1"
    });
    assert.deepEqual(parseSupportRoute({ view: "capabilities", segments: ["hello"] }), {
      view: "workflows",
      segments: ["hello"],
      hash: ""
    });
    assert.equal(parseSupportRoute({}).view, "home");
  });

  it("summarizes scalar input while dropping internals and secret-shaped fields", () => {
    assert.equal(
      safeSupportInput({
        prompt: "Ship the widget",
        token: "shub_secret",
        __origin: "internal",
        count: 3,
        nested: { skip: true },
        empty: ""
      }),
      "prompt=Ship the widget, count=3"
    );
    assert.equal(safeSupportInput(["bad"]), "");
  });

  it("redacts and bounds context values", () => {
    const redacted = redactContextValue("authorization: Bearer sk-abc123def456ghi789 done");
    assert.doesNotMatch(redacted, /sk-abc123def456/);
    assert.match(redacted, /\[redacted\]/);
    assert.equal(redactContextValue("a ".repeat(200), 12).length <= 12, true);
  });
});
