import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canTransitionRun,
  RUN_TERMINAL,
  runTransitionDecision,
  shouldReleaseRunnerSlotOnTransition
} from "../src/runLifecyclePolicy.js";
import { RUN_FAILURE_TERMINAL_STATUSES } from "../src/runFailureClass.js";

describe("run lifecycle policy", () => {
  it("treats all classified failures as terminal queued/assigned/running targets", () => {
    for (const status of RUN_FAILURE_TERMINAL_STATUSES) {
      assert.equal(RUN_TERMINAL.has(status), true, `${status} should be terminal`);
      assert.equal(canTransitionRun("queued", status), true, `queued -> ${status}`);
      assert.equal(canTransitionRun("assigned", status), true, `assigned -> ${status}`);
      assert.equal(canTransitionRun("running", status), true, `running -> ${status}`);
    }
  });

  it("decides normal, invalid, missing, and idempotent transitions", () => {
    assert.deepEqual(runTransitionDecision(null, "running"), {
      ok: false,
      code: 404,
      error: "run not found"
    });
    assert.deepEqual(runTransitionDecision({ status: "queued" }, "running"), {
      ok: true,
      idempotent: false
    });
    assert.deepEqual(runTransitionDecision({ status: "waiting_approval" }, "running"), {
      ok: false,
      code: 409,
      error: "cannot transition run from 'waiting_approval' to 'running'"
    });
    assert.deepEqual(runTransitionDecision({ status: "succeeded" }, "succeeded"), {
      ok: true,
      idempotent: true
    });
  });

  it("treats late terminal-vs-terminal writes as benign races", () => {
    assert.deepEqual(runTransitionDecision({ status: "cancelled" }, "failed"), {
      ok: true,
      idempotent: true,
      raced: true
    });
  });

  it("releases runner slots only when active runs become terminal", () => {
    assert.equal(shouldReleaseRunnerSlotOnTransition({ status: "running", runnerId: "runner_1" }, "succeeded"), true);
    assert.equal(shouldReleaseRunnerSlotOnTransition({ status: "assigned", runnerId: "runner_1" }, "failed"), true);
    assert.equal(shouldReleaseRunnerSlotOnTransition({ status: "queued", runnerId: "runner_1" }, "cancelled"), false);
    assert.equal(shouldReleaseRunnerSlotOnTransition({ status: "running", runnerId: "" }, "failed"), false);
    assert.equal(shouldReleaseRunnerSlotOnTransition({ status: "running", runnerId: "runner_1" }, "running"), false);
  });
});
