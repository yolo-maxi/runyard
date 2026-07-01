import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyChildState } from "../src/runSmithersClassification.js";
import { decideNextAction } from "../src/runSmithersDecision.js";
import {
  createWatcherState,
  recordChildAttempt,
  recordRepairAttempt
} from "../src/runSmithersState.js";

describe("run-smithers decision policy", () => {
  it("keeps terminal success, in-progress, approval, and cancellation branches explicit", () => {
    const state = createWatcherState({ capabilitySlug: "hello" });
    assert.equal(decideNextAction(state, classifyChildState({ status: "running" })).action, "observe");
    assert.equal(decideNextAction(state, classifyChildState({ status: "waiting_approval" })).action, "wait_approval");

    recordChildAttempt(state, { runId: "run_cancel", status: "cancelled" });
    assert.equal(decideNextAction(state, classifyChildState({ status: "cancelled" })).action, "give_up");

    const ok = createWatcherState({ capabilitySlug: "hello" });
    assert.equal(decideNextAction(ok, classifyChildState({ status: "succeeded", output: { ok: true } })).action, "succeed");
    assert.equal(ok.outcome, "succeeded");
  });

  it("escalates deterministic non-retryable failures instead of retrying them", () => {
    const state = createWatcherState({ capabilitySlug: "hello" });
    recordChildAttempt(state, {
      runId: "run_preflight",
      status: "blocked_by_preflight",
      error: "workflow file not found"
    });

    const decision = decideNextAction(state, classifyChildState({ status: "blocked_by_preflight" }));
    assert.equal(decision.action, "approval");
    assert.equal(decision.escalation, "non_retryable_failure_class");
    assert.equal(decision.failureClass, "blocked_by_preflight");
    assert.equal(state.approvalRequested, true);
  });

  it("repairs workflow-code failures once per fingerprint, then escalates repeats", () => {
    const state = createWatcherState({ capabilitySlug: "product-workflow", maxCodeRepairs: 1 });
    const error = "TypeError: Cannot read properties of undefined at product-workflow.tsx:1:1";

    recordChildAttempt(state, { runId: "run_a", status: "failed", failedStep: "dispatch", error });
    const first = decideNextAction(state, classifyChildState({ status: "failed" }));
    assert.equal(first.action, "repair");
    assert.equal(first.capability, "product-workflow");

    recordRepairAttempt(state, { fingerprint: first.fingerprint, ok: true });
    recordChildAttempt(state, { runId: "run_b", status: "failed", failedStep: "dispatch", error });
    const second = decideNextAction(state, classifyChildState({ status: "failed" }));
    assert.equal(second.action, "approval");
    assert.equal(second.escalation, "workflow_code_repair_failed");
  });

  it("uses retry, fingerprint escalation, and max-attempt escalation in order", () => {
    const retryState = createWatcherState({ capabilitySlug: "hello", maxAttempts: 5, fingerprintThreshold: 3 });
    recordChildAttempt(retryState, { runId: "run_a", status: "failed", error: "temporary provider issue" });
    const retry = decideNextAction(retryState, classifyChildState({ status: "failed", checkpoint: "step_1" }));
    assert.equal(retry.action, "retry");
    assert.equal(retry.checkpoint, "step_1");

    const fingerprintState = createWatcherState({ capabilitySlug: "hello", maxAttempts: 10, fingerprintThreshold: 2 });
    recordChildAttempt(fingerprintState, { runId: "run_1", status: "failed", error: "same boom" });
    recordChildAttempt(fingerprintState, { runId: "run_2", status: "failed", error: "same boom" });
    assert.equal(decideNextAction(fingerprintState, classifyChildState({ status: "failed" })).action, "approval");

    const maxState = createWatcherState({ capabilitySlug: "hello", maxAttempts: 1, fingerprintThreshold: 99 });
    recordChildAttempt(maxState, { runId: "run_1", status: "failed", error: "boom" });
    assert.match(decideNextAction(maxState, classifyChildState({ status: "failed" })).reason, /maxAttempts/);
  });

  it("parks failures after non-resumable child side-effect steps", () => {
    const deployState = createWatcherState({ capabilitySlug: "implement-change-gated", maxAttempts: 5 });
    recordChildAttempt(deployState, {
      runId: "run_deploy",
      status: "failed",
      failedStep: "deploy",
      error: "smithers run run-1 failed at node 'deploy': git push prod failed",
      checkpoint: "run-1"
    });
    const deployDecision = decideNextAction(deployState, classifyChildState({ status: "failed", checkpoint: "run-1" }));
    assert.equal(deployDecision.action, "approval");
    assert.equal(deployDecision.escalation, "non_resumable_child_step");

    const stalledState = createWatcherState({ capabilitySlug: "implement-change-gated", maxAttempts: 5 });
    recordChildAttempt(stalledState, {
      runId: "run_stalled",
      status: "failed",
      failedStep: "stalled",
      error: "run emitted no events within stall window",
      checkpoint: "run-2"
    });
    const stalledDecision = decideNextAction(stalledState, classifyChildState({ status: "failed", checkpoint: "run-2" }));
    assert.equal(stalledDecision.action, "approval");
    assert.equal(stalledDecision.escalation, "possibly_live_child");
  });
});
