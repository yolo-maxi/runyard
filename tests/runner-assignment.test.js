import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runnerMatchesAssignment,
  secretNamesForRun,
  supportRunnerAvailabilityResult
} from "../src/runnerAssignment.js";

describe("runner assignment helpers", () => {
  it("matches required tags and execution location intent", () => {
    const capability = { requiredRunnerTags: ["smithers"] };
    const runner = { tags: ["smithers", "local"] };

    assert.equal(runnerMatchesAssignment(capability, runner, { input: { topic: "x" } }), true);
    assert.equal(
      runnerMatchesAssignment(capability, runner, { input: { __execution: { requested: true, runnerLocation: "local" } } }),
      true
    );
    assert.equal(
      runnerMatchesAssignment(capability, runner, { input: { __execution: { requested: true, runnerLocation: "vps" } } }),
      false
    );
    assert.equal(runnerMatchesAssignment({ requiredRunnerTags: ["missing"] }, runner, { input: {} }), false);
    assert.equal(runnerMatchesAssignment(capability, null, { input: {} }), false);
  });

  it("summarizes support runner availability without leaking extra runner fields", () => {
    const capability = { enabled: true, requiredRunnerTags: ["support"] };
    const result = supportRunnerAvailabilityResult({
      capability,
      runners: [
        { id: "offline", online: false, tags: ["support"], tokenId: "secret" },
        { id: "ok", name: "Runner", online: true, tags: ["support"], capacity: 2, workRuns: 1, availableSlots: 1, tokenId: "secret" }
      ]
    });

    assert.deepEqual(result, {
      available: true,
      reason: "",
      runners: [
        {
          id: "ok",
          name: "Runner",
          tags: ["support"],
          capacity: 2,
          workRuns: 1,
          availableSlots: 1
        }
      ]
    });
  });

  it("reports unavailable support capability and missing runner tags", () => {
    assert.deepEqual(supportRunnerAvailabilityResult({ capability: null, runners: [] }), {
      available: false,
      reason: "support capability is not installed",
      runners: []
    });
    assert.deepEqual(supportRunnerAvailabilityResult({
      capability: { enabled: true, requiredRunnerTags: ["support"] },
      runners: [{ id: "wrong", online: true, tags: ["smithers"] }]
    }), {
      available: false,
      reason: "no online runner advertises required tags: support",
      runners: []
    });
  });

  it("dedupes and trims run secret allowlists", () => {
    assert.deepEqual(secretNamesForRun(
      { workflow: { secrets: [" API_KEY ", "", "TOKEN"] } },
      { secretNames: ["TOKEN", "EXTRA", null] }
    ), ["API_KEY", "TOKEN", "EXTRA"]);
  });
});
