import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyChildState,
  classifyFailureClass,
  classifyWorkflowCodeFailure,
  normalizeErrorFingerprint
} from "../src/runSmithersClassification.js";

describe("run-smithers classification helpers", () => {
  it("normalizes volatile error fragments into stable fingerprints", () => {
    const first = normalizeErrorFingerprint(
      "pnpm install failed at run_abcdef012345 in /tmp/runyard-a at 2026-06-19T10:00:00.000Z"
    );
    const second = normalizeErrorFingerprint(
      "pnpm install failed at run_999999999999 in /tmp/runyard-b at 2026-06-19T10:05:00.000Z"
    );
    assert.equal(first, second);
    assert.equal(normalizeErrorFingerprint("   "), "");
  });

  it("classifies retryable, non-retryable, and generic failures", () => {
    assert.equal(classifyFailureClass({ status: "provider_limited" }), "provider_limited");
    assert.equal(classifyFailureClass({ error: "preflight failed: workflow file not found" }), "blocked_by_preflight");
    assert.equal(classifyFailureClass({ error: "verification failed during tests" }), "blocked_by_gate");
    assert.equal(classifyFailureClass({ error: "unknown boom" }), "failed");
  });

  it("separates deterministic workflow-code bugs from infra failures", () => {
    assert.deepEqual(classifyWorkflowCodeFailure("TypeError: cannot read properties of undefined"), {
      isCodeFailure: true,
      kind: "workflow_code"
    });
    assert.deepEqual(classifyWorkflowCodeFailure("pnpm install failed: ENOSPC writing /tmp/x"), {
      isCodeFailure: false,
      kind: "infra"
    });
  });

  it("classifies child terminal, running, approval, and recoverable states", () => {
    assert.equal(classifyChildState({ status: "succeeded", output: { ok: true } }).promotedSuccess, true);
    assert.equal(classifyChildState({ status: "succeeded", output: null }).promotedSuccess, false);
    assert.equal(classifyChildState({ status: "failed", input: { __checkpoint: "build" } }).recoverable, true);
    assert.equal(classifyChildState({ status: "waiting_approval" }).kind, "waiting_approval");
    assert.equal(classifyChildState({ status: "running" }).terminal, false);
    assert.equal(classifyChildState(null).kind, "unknown");
  });
});
