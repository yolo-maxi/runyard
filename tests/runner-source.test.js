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

  it("defers the deadline instead of timing out while the hub reports an approval hold", () => {
    // A run blocked on a pending human approval must never become timed_out:
    // the runner reads the hub-computed approvalHold from the run detail and
    // pushes its deadline forward while the decision is pending.
    assert.match(source, /approvalHold: Boolean\(detail\?\.approvalHold\)/);
    assert.match(source, /hubRun\.approvalHold/);
    assert.match(source, /deadline = Date\.now\(\) \+ maxRunMs/);
    assert.match(source, /runner\.deadline_deferred/);
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
    // The child env is the allowlisted OS/toolchain baseline plus the explicit
    // supervisor/secret/run channels — never a raw spread of the runner's env.
    assert.match(smithersRuntimeSource, /\.\.\.allowlistedBaseEnv\(baseEnv\), \.\.\.supervisorEnv, \.\.\.secretEnv/);
    assert.doesNotMatch(smithersRuntimeSource, /\{ \.\.\.baseEnv,/);
  });

  it("can exit after a bounded number of assignments for smoke evaluation", () => {
    assert.match(source, /SMITHERS_RUNNER_EXIT_AFTER_RUNS/);
    assert.match(source, /function maybeExitAfterRuns/);
    assert.match(source, /Smithers runner exiting after/);
  });
});

describe("DB-backed workflow bundle materialization", () => {
  it("materializes hub-shipped bundles before preflight and rewires the run entry", () => {
    assert.match(source, /materializeWorkflowBundle\(run, capability, assignment\.workflowBundle, \{ workspace \}\)/);
    assert.match(source, /if \(workflowBundle\) entry = workflowBundle\.entry/);
    assert.match(source, /runner\.workflow_bundle_materialized/);
  });

  it("treats materialization gaps as preflight failures, never template fallback", () => {
    assert.match(source, /workflow bundle materialization failed/);
    assert.match(source, /const preflightFailures = bundleFailure\s*\?\s*\[bundleFailure\]/);
  });

  it("never posts bundle source code in the materialization event", () => {
    const eventData = source.match(/runner\.workflow_bundle_materialized[\s\S]*?\{([\s\S]*?)\}\s*\);/)?.[1] || "";
    assert.ok(eventData.includes("sha256"));
    assert.ok(eventData.includes("bundleId"));
    assert.equal(/code\s*:/.test(eventData), false);
  });
});
