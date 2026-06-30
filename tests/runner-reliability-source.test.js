import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runnerSource = readFileSync(new URL("../src/runner.js", import.meta.url), "utf8");

describe("runner reliability source guards", () => {
  it("streams large Smithers input over stdin instead of argv", () => {
    assert.match(runnerSource, /MAX_INLINE_INPUT_BYTES/);
    assert.match(runnerSource, /args\.push\("--input", "-"\)/);
    assert.match(runnerSource, /stdin: inputPayload\.stdin/);
    assert.doesNotMatch(runnerSource, /--input-file/);
  });

  it("runs preflight before launching the expensive Smithers workflow", () => {
    const preflightIndex = runnerSource.indexOf("preflightAssignment(run, capability, entry)");
    const launchIndex = runnerSource.indexOf("const sid = await launch(entry, run.input, secretEnv, resume)");
    assert.ok(preflightIndex > 0, "preflight call should exist");
    assert.ok(launchIndex > 0, "launch call should exist");
    assert.ok(preflightIndex < launchIndex, "preflight should happen before launch");
    assert.match(runnerSource, /BLOCKED_BY_PREFLIGHT/);
  });
});
