import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/runner.js", import.meta.url), "utf8");

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

  it("hands its resolved hub token/url down to the run-smithers supervisor child", () => {
    // The supervisor workflow calls back into the hub to spawn children; a runner
    // set up with only RUNYARD_HUB_TOKEN must still pass a token down, otherwise
    // run-smithers throws "needs RUNYARD_HUB_TOKEN / RUN_SMITHERS_HUB_TOKEN".
    assert.match(source, /supervisorEnv\.RUN_SMITHERS_HUB_TOKEN = token/);
    assert.match(source, /supervisorEnv\.RUN_SMITHERS_HUB_URL = baseUrl/);
    assert.match(source, /\.\.\.process\.env, \.\.\.supervisorEnv, \.\.\.secretEnv/);
  });

  it("can exit after a bounded number of assignments for smoke evaluation", () => {
    assert.match(source, /SMITHERS_RUNNER_EXIT_AFTER_RUNS/);
    assert.match(source, /function maybeExitAfterRuns/);
    assert.match(source, /Smithers runner exiting after/);
  });
});
