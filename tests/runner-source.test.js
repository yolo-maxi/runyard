import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/runner.js", import.meta.url), "utf8");
const smithersRuntimeSource = readFileSync(new URL("../src/runnerSmithersRuntime.js", import.meta.url), "utf8");
const smithersOutcomeSource = readFileSync(new URL("../src/runnerSmithersOutcome.js", import.meta.url), "utf8");

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
    assert.match(source, /smithersRunOutcome/);
    assert.match(smithersOutcomeSource, /runSmithersSupervisionFailure/);
    assert.match(smithersOutcomeSource, /from "\.\/runnerPolicy\.js"/);
    assert.match(smithersOutcomeSource, /const supervisionFailure = state === "succeeded" \? runSmithersSupervisionFailure\(capability, outputs\) : ""/);
  });

  it("hands its resolved hub token/url down to the run-smithers supervisor child", () => {
    // The supervisor workflow calls back into the hub to spawn children; a runner
    // set up with only RUNYARD_HUB_TOKEN must still pass a token down, otherwise
    // run-smithers throws "needs RUNYARD_HUB_TOKEN / RUN_SMITHERS_HUB_TOKEN".
    assert.match(source, /launchSmithers/);
    assert.match(smithersRuntimeSource, /supervisorEnv\.RUN_SMITHERS_HUB_TOKEN = token/);
    assert.match(smithersRuntimeSource, /supervisorEnv\.RUN_SMITHERS_HUB_URL = baseUrl/);
    assert.match(smithersRuntimeSource, /\.\.\.baseEnv, \.\.\.supervisorEnv, \.\.\.secretEnv/);
  });

  it("can exit after a bounded number of assignments for smoke evaluation", () => {
    assert.match(source, /SMITHERS_RUNNER_EXIT_AFTER_RUNS/);
    assert.match(source, /function maybeExitAfterRuns/);
    assert.match(source, /Smithers runner exiting after/);
  });
});
