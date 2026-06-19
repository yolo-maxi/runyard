import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/smithers-runner.js", import.meta.url), "utf8");

describe("Smithers runner deadline containment", () => {
  it("uses a long enough default deadline for real agent workflows", () => {
    assert.match(source, /2 \* 60 \* 60_000/);
  });

  it("cancels detached Smithers workflows when the Hub runner deadline expires", () => {
    assert.match(source, /function cancelSmithersRun/);
    assert.match(source, /\["cancel", sid\]/);
    assert.match(source, /runner\.deadline_exceeded/);
  });

  it("does not mark run-smithers needs_recovery as successful", () => {
    assert.match(source, /function runSmithersSupervisionFailure/);
    assert.match(source, /capability\?\.slug !== "run-smithers"/);
    assert.match(source, /outputs\?\.supervise\?\.outcome/);
    assert.match(source, /run-smithers ended with outcome/);
  });
});
