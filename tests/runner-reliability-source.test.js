import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runnerSource = readFileSync(new URL("../src/runner.js", import.meta.url), "utf8");
const smithersRuntimeSource = readFileSync(new URL("../src/runnerSmithersRuntime.js", import.meta.url), "utf8");
const smithersOutcomeSource = readFileSync(new URL("../src/runnerSmithersOutcome.js", import.meta.url), "utf8");

describe("runner reliability source guards", () => {
  it("streams large Smithers input over stdin instead of argv", () => {
    assert.match(runnerSource, /MAX_INLINE_INPUT_BYTES/);
    assert.match(smithersRuntimeSource, /args\.push\("--input", "-"\)/);
    assert.match(smithersRuntimeSource, /stdin: inputPayload\.stdin/);
    assert.match(smithersRuntimeSource, /largeInputPayload\(cleanInput, maxInlineInputBytes\)/);
    assert.doesNotMatch(smithersRuntimeSource, /--input-file/);
  });

  it("runs preflight before launching the expensive Smithers workflow", () => {
    const preflightIndex = runnerSource.indexOf("preflightAssignment(run, capability, entry");
    const launchIndex = runnerSource.indexOf("const sid = await launch(entry, run.input,");
    assert.ok(preflightIndex > 0, "preflight call should exist");
    assert.ok(launchIndex > 0, "launch call should exist");
    assert.ok(preflightIndex < launchIndex, "preflight should happen before launch");
    assert.match(runnerSource, /BLOCKED_BY_PREFLIGHT/);
  });

  it("does not report productive success for empty or no-op Improve outputs", () => {
    const guardIndex = runnerSource.indexOf("smithersRunOutcome({");
    const completeIndex = runnerSource.lastIndexOf("client.post(`/api/runs/${run.id}/complete`");
    assert.ok(guardIndex > 0, "productive outcome guard should exist");
    assert.ok(completeIndex > 0, "complete call should exist");
    assert.ok(guardIndex < completeIndex, "productive outcome guard should run before complete");
    assert.match(smithersOutcomeSource, /productiveOutcomeFailure\(capability, outputs\)/);
    assert.match(smithersOutcomeSource, /from "\.\/runnerPolicy\.js"/);
  });

  it("only skips local outcome reporting when the Hub is already terminal", () => {
    assert.match(runnerSource, /if \(isHubTerminalStatus\(hubTerminalStatus\)\) \{/);
    assert.doesNotMatch(runnerSource, /if \(hubTerminalStatus\) \{\s*console\.log\(`Run \$\{run\.id\} stopped locally because Hub is already/);
  });
});
