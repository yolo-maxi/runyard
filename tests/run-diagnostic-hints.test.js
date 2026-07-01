import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  quickFailedStep,
  quickReasonHint
} from "../src/runDiagnosticHints.js";

describe("run diagnostic hint helpers", () => {
  it("builds cheap run-list reason hints", () => {
    assert.equal(quickReasonHint({ status: "failed", error: "x".repeat(200) }).length, 140);
    assert.equal(quickReasonHint({ status: "cancelled", currentStep: "cancel step" }), "cancel step");
    assert.equal(quickReasonHint({ status: "waiting_approval", currentStep: "approve" }), "approve");
    assert.equal(quickReasonHint({ status: "succeeded" }), "");
  });

  it("bounds failed step hints", () => {
    assert.equal(quickFailedStep({ status: "waiting_approval", currentStep: "approve" }), "approve");
    assert.equal(quickFailedStep({ status: "succeeded", currentStep: "done" }), "");
    assert.equal(quickFailedStep({ status: "failed", currentStep: "x".repeat(100) }).length, 80);
  });
});
