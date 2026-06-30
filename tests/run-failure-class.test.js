import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFailureStatus,
  failureEventType,
  normalizeFailureStatus,
  RUN_FAILURE_CLASSES
} from "../src/runFailureClass.js";
import { canTransitionRun, RUN_TERMINAL } from "../src/db.js";

describe("run failure classes", () => {
  it("classifies common terminal failure modes", () => {
    assert.equal(classifyFailureStatus("preflight failed: workflow file not found"), RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT);
    assert.equal(classifyFailureStatus("GATE FAILED: pnpm test failed"), RUN_FAILURE_CLASSES.BLOCKED_BY_GATE);
    assert.equal(classifyFailureStatus("provider returned 429 rate limit"), RUN_FAILURE_CLASSES.PROVIDER_LIMITED);
    assert.equal(classifyFailureStatus("runner deadline exceeded"), RUN_FAILURE_CLASSES.TIMED_OUT);
    assert.equal(classifyFailureStatus("invalid output: zod schema mismatch"), RUN_FAILURE_CLASSES.INVALID_OUTPUT);
    assert.equal(classifyFailureStatus("runner heartbeat expired"), RUN_FAILURE_CLASSES.INFRA_UNAVAILABLE);
    assert.equal(classifyFailureStatus("operator approval required"), RUN_FAILURE_CLASSES.NEEDS_HUMAN);
  });

  it("normalizes unknown statuses back to failed", () => {
    assert.equal(normalizeFailureStatus("wat"), RUN_FAILURE_CLASSES.FAILED);
    assert.equal(failureEventType("provider_limited"), "run.provider_limited");
    assert.equal(failureEventType("wat"), "run.failed");
  });

  it("treats richer failure classes as terminal run statuses", () => {
    for (const status of Object.values(RUN_FAILURE_CLASSES)) {
      assert.equal(RUN_TERMINAL.has(status), true, `${status} should be terminal`);
      assert.equal(canTransitionRun("queued", status), true, `queued -> ${status}`);
      assert.equal(canTransitionRun("assigned", status), true, `assigned -> ${status}`);
      assert.equal(canTransitionRun("running", status), true, `running -> ${status}`);
    }
  });
});
