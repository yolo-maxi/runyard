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
    const launchIndex = runnerSource.indexOf("const sid = await launch(entry, run.input,");
    assert.ok(preflightIndex > 0, "preflight call should exist");
    assert.ok(launchIndex > 0, "launch call should exist");
    assert.ok(preflightIndex < launchIndex, "preflight should happen before launch");
    assert.match(runnerSource, /BLOCKED_BY_PREFLIGHT/);
    assert.match(runnerSource, /resolveImproveRepo\(run\?\.input \|\| \{\}/);
    assert.match(runnerSource, /improve repo preflight failed/);
  });

  it("does not report productive success for empty or no-op Improve outputs", () => {
    const guardIndex = runnerSource.indexOf("productiveOutcomeFailure(capability, outputs)");
    const completeIndex = runnerSource.indexOf("client.post(`/api/runs/${run.id}/complete`");
    assert.ok(guardIndex > 0, "productive outcome guard should exist");
    assert.ok(completeIndex > 0, "complete call should exist");
    assert.ok(guardIndex < completeIndex, "productive outcome guard should run before complete");
    assert.match(runnerSource, /invalid output: succeeded workflow produced no node outputs/);
    assert.match(runnerSource, /invalid output: improve succeeded without changed files/);
    assert.match(runnerSource, /baseline\?\.repoDir \|\| baseline\?\.repo_dir/);
    assert.match(runnerSource, /hasExplicitNoChangeRationale/);
  });
});
