import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/runner.js", import.meta.url), "utf8");
const smithersRuntimeSource = readFileSync(new URL("../src/runnerSmithersRuntime.js", import.meta.url), "utf8");

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

  it("hands its resolved hub token/url down to Smithers workflow children", () => {
    assert.match(source, /launchSmithers/);
    assert.match(smithersRuntimeSource, /hubEnv\.RUNYARD_HUB_TOKEN = token/);
    assert.match(smithersRuntimeSource, /hubEnv\.RUNYARD_HUB_URL = baseUrl/);
    // The child env is the allowlisted OS/toolchain baseline plus the pinned
    // engine-behavior guards plus the explicit hub/secret/run channels —
    // never a raw spread of the runner's env.
    assert.match(smithersRuntimeSource, /\.\.\.allowlistedBaseEnv\(baseEnv\), \.\.\.ENGINE_BEHAVIOR_ENV, \.\.\.hubEnv, \.\.\.secretEnv/);
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
