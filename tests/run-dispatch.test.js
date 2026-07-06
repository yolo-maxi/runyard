import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRunDispatcher } from "../src/runDispatch.js";

function dispatchHarness() {
  const created = [];
  const dispatchRun = createRunDispatcher({
    createRun: (capability, input, options = {}) => {
      const run = { id: `run_${created.length + 1}`, capabilitySlug: capability.slug, input, options };
      created.push({ capability, input, options, run });
      return run;
    }
  });
  return { created, dispatchRun };
}

describe("run dispatcher", () => {
  it("dispatches capabilities directly even when stale policy flags remain", () => {
    const { created, dispatchRun } = dispatchHarness();
    const result = dispatchRun(
      { slug: "improve", name: "Improve", enabled: true, supervision: { default: true } },
      { goal: "polish", target: "app" },
      { requestedBy: "operator", origin: { type: "api" } }
    );

    assert.equal(result.run.capabilitySlug, "improve");
    assert.deepEqual(Object.keys(result), ["run"]);
    assert.deepEqual(created[0].input, { goal: "polish", target: "app" });
    assert.deepEqual(created[0].options, { requestedBy: "operator", origin: { type: "api" } });
  });

  it("does not create wrapper metadata", () => {
    const { created, dispatchRun } = dispatchHarness();

    const result = dispatchRun(
      { slug: "improve", name: "Improve", enabled: true },
      { target: "app" },
      { origin: { type: "api" } }
    );

    assert.equal(result.run.capabilitySlug, "improve");
    assert.deepEqual(Object.keys(result), ["run"]);
    assert.deepEqual(created[0].input, { target: "app" });
    assert.deepEqual(created[0].options, { origin: { type: "api" } });
  });
});
