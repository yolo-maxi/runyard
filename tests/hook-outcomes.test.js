import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateHookStatus,
  collectHookOutcomes,
  HOOK_OUTCOME_STATUSES,
  isHookOutcomeStatus
} from "../src/hookOutcomes.js";
import { runOutcomeSummary } from "../src/runOutcomePresentation.js";

describe("hook outcomes", () => {
  it("exposes the shared status vocabulary", () => {
    assert.deepEqual(HOOK_OUTCOME_STATUSES, [
      "succeeded",
      "hook_failed",
      "hook_config_required",
      "hook_blocked",
      "skipped"
    ]);
    assert.equal(isHookOutcomeStatus("hook_failed"), true);
    assert.equal(isHookOutcomeStatus("failed"), false);
  });

  it("aggregates per-hook results by severity", () => {
    assert.equal(aggregateHookStatus([]), "skipped");
    assert.equal(aggregateHookStatus([{ status: "succeeded" }]), "succeeded");
    assert.equal(aggregateHookStatus([{ status: "succeeded" }, { status: "hook_blocked" }]), "hook_blocked");
    assert.equal(
      aggregateHookStatus([{ status: "hook_config_required" }, { status: "hook_failed" }]),
      "hook_failed"
    );
  });

  it("collects hooks-node outcomes and normalizes results", () => {
    const outcomes = collectHookOutcomes({
      outputs: {
        build: { summary: "built" },
        hooks: {
          status: "hook_failed",
          results: [
            { profile: "static-publish", status: "hook_failed", detail: "Expected 200, got 502" },
            { profile: "bogus", status: "not-a-status" }
          ]
        }
      }
    });
    assert.equal(outcomes.status, "hook_failed");
    assert.deepEqual(outcomes.results, [
      { profile: "static-publish", status: "hook_failed", detail: "Expected 200, got 502" }
    ]);
  });

  it("reads hook-style statuses off legacy deploy nodes and ignores old runs", () => {
    const legacy = collectHookOutcomes({
      outputs: { deploy: { status: "hook_config_required", verify: "post-run hook configuration required" } }
    });
    assert.equal(legacy.status, "hook_config_required");
    assert.equal(legacy.results[0].profile, "legacy:deploy");

    // Pre-hooks runs (deploy node without a hook status) stay untouched.
    assert.equal(collectHookOutcomes({ outputs: { deploy: { deployed: true, verify: "ok" } } }), null);
    assert.equal(collectHookOutcomes({ outputs: { build: {} } }), null);
    assert.equal(collectHookOutcomes(null), null);
  });

  it("keeps a green build green when only a hook failed", () => {
    const greenBuildFailedHook = runOutcomeSummary({
      status: "succeeded",
      output: {
        outputs: {
          build: { summary: "Built the MVP." },
          verify: { passed: true },
          hooks: {
            status: "hook_failed",
            results: [{ profile: "static-publish", status: "hook_failed", detail: "rsync exited 23" }]
          }
        }
      }
    });
    assert.equal(greenBuildFailedHook.classification, "succeeded");
    assert.equal(greenBuildFailedHook.hooks.status, "hook_failed");

    // ...which is a different thing from a build that actually failed.
    const failedBuild = runOutcomeSummary({
      status: "failed",
      output: { outputs: { build: { summary: "Build blew up." } } }
    });
    assert.equal(failedBuild.classification, "failed");
    assert.equal(failedBuild.hooks, null);
    assert.notEqual(greenBuildFailedHook.classification, failedBuild.classification);
  });
});
