import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyConfigFailure,
  decideReconcile,
  HUB_DEFAULT_CAPS,
  HUB_SUPERVISOR_DECISION_SCHEMA
} from "../src/hubSupervisorDecision.js";

function fpOf(error) {
  return decideReconcile({ reason: "failed", error, checkpoint: "run-1" }).fingerprint;
}

describe("hub supervisor decision helpers", () => {
  it("classifies operator-must-fix runner config failures", () => {
    assert.equal(classifyConfigFailure("run-smithers needs RUNYARD_HUB_TOKEN on the runner").isConfigFailure, true);
    assert.equal(classifyConfigFailure("spawn codex ENOENT").isConfigFailure, true);
    assert.equal(classifyConfigFailure("econnreset talking to provider").isConfigFailure, false);
  });

  it("returns stable schema and resumes recoverable checkpointed failures", () => {
    const decision = decideReconcile({ reason: "runner_offline", error: "econnreset", checkpoint: "run-1", attempt: 0 });
    assert.equal(decision.schema, HUB_SUPERVISOR_DECISION_SCHEMA);
    assert.equal(decision.action, "resume");
    assert.equal(decision.nextAttempt, 1);
  });

  it("gives up or escalates for unsafe/non-recoverable cases", () => {
    assert.equal(decideReconcile({ cancelledIntent: true, checkpoint: "run-1" }).action, "give_up");
    assert.equal(decideReconcile({ reason: "run_stalled", checkpoint: "run-1" }).action, "give_up");
    assert.equal(decideReconcile({ reason: "failed", checkpoint: null }).action, "give_up");
    assert.equal(decideReconcile({ reason: "failed", checkpoint: "run-1", resumeSafe: false }).escalation, "non_resumable_step");
    assert.equal(decideReconcile({ reason: "failed", checkpoint: "run-1", attempt: HUB_DEFAULT_CAPS.maxAttempts }).escalation, "max_attempts");
  });

  it("enforces loop-breaker, repair, and three-strike policy", () => {
    const transient = "econnreset talking to the model gateway";
    const loop = decideReconcile({
      reason: "runner_offline",
      error: transient,
      checkpoint: "run-1",
      fingerprintResumes: { [fpOf(transient)]: HUB_DEFAULT_CAPS.maxResumesPerFingerprint },
      progressMarker: 5,
      lastProgressMarker: 5
    });
    assert.equal(loop.escalation, "loop_breaker");

    const codeError = "ReferenceError: foo is not defined at workflow.tsx:12:3";
    const repair = decideReconcile({ reason: "failed", error: codeError, checkpoint: "run-1", enableRepair: true });
    assert.equal(repair.action, "repair");
    const repaired = decideReconcile({
      reason: "failed",
      error: codeError,
      checkpoint: "run-1",
      enableRepair: true,
      repairedFingerprints: { [repair.fingerprint]: 1 },
      repairCount: 1
    });
    assert.equal(repaired.escalation, "code_repair_exhausted");

    const threeStrike = decideReconcile({
      reason: "failed",
      error: "TypeError: x is not a function",
      checkpoint: "run-1",
      caps: { maxResumesPerFingerprint: HUB_DEFAULT_CAPS.fingerprintThreshold + 1 },
      fingerprintResumes: { [fpOf("TypeError: x is not a function")]: HUB_DEFAULT_CAPS.fingerprintThreshold - 1 },
      progressMarker: 1,
      lastProgressMarker: 1
    });
    assert.equal(threeStrike.escalation, "three_strike");
  });
});
