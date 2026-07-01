import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSupervisionSucceeded } from "../src/runSmithersGate.js";

describe("run-smithers supervision gate", () => {
  it("returns successful results unchanged", () => {
    const result = { outcome: "succeeded", capability: "hello" };
    assert.equal(assertSupervisionSucceeded(result), result);
  });

  it("throws an actionable error for failed or unknown wrapper outcomes", () => {
    assert.throws(
      () => assertSupervisionSucceeded({
        outcome: "needs_recovery",
        capability: "product-workflow",
        lineage: [{}, {}],
        repairs: [{}],
        codeRepairs: 1,
        approval: { reason: "review" },
        summary: "attempts=2"
      }),
      (error) => {
        assert.match(error.message, /product-workflow/);
        assert.match(error.message, /needs_recovery/);
        assert.match(error.message, /attempts=2 repairs=1 codeRepairs=1 approvalRequested=true/);
        assert.match(error.message, /summary: attempts=2/);
        return true;
      }
    );
    assert.throws(() => assertSupervisionSucceeded(null), /unknown/);
  });
});
