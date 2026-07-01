import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RUN_FAILURE_CLASSES } from "../src/runFailureClass.js";
import { smithersRunOutcome } from "../src/runnerSmithersOutcome.js";

describe("runner Smithers outcome helper", () => {
  it("completes successful workflows with Smithers run id and outputs", () => {
    assert.deepEqual(smithersRunOutcome({
      capability: { slug: "hello" },
      state: "succeeded",
      sid: "run-1",
      outputs: { answer: { text: "hi" } }
    }), {
      ok: true,
      output: {
        smithersRunId: "run-1",
        outputs: { answer: { text: "hi" } }
      }
    });
  });

  it("turns run-smithers non-success supervision outcomes into runner failures", () => {
    const outcome = smithersRunOutcome({
      capability: { slug: "run-smithers" },
      state: "succeeded",
      sid: "run-2",
      outputs: { supervise: { outcome: "needs_recovery", summary: "child failed" } }
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, "");
    assert.match(outcome.error, /needs_recovery/);
  });

  it("rejects productive success when workflow outputs fail policy checks", () => {
    const outcome = smithersRunOutcome({
      capability: { slug: "improve" },
      state: "succeeded",
      sid: "run-3",
      outputs: { baseline: { repoDir: "/repo" }, commit: { files: [] } }
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, RUN_FAILURE_CLASSES.INVALID_OUTPUT);
    assert.match(outcome.error, /without changed files/);
  });

  it("reports timed out Smithers runs with the timeout failure class", () => {
    assert.deepEqual(smithersRunOutcome({
      capability: { slug: "hello" },
      state: "cancelled",
      sid: "run-4",
      outputs: {},
      deadlineExceeded: true,
      maxRunMs: 123
    }), {
      ok: false,
      error: "smithers run run-4 exceeded runner deadline (123ms) and was cancelled",
      status: RUN_FAILURE_CLASSES.TIMED_OUT
    });
  });

  it("extracts failing-node details before falling back to generic state text", () => {
    const detailed = smithersRunOutcome({
      capability: { slug: "hello" },
      state: "failed",
      sid: "run-5",
      inspect: {
        steps: [{ id: "build", status: "failed", error: "TypeError: x is not a function" }]
      },
      eventLines: []
    });
    assert.equal(detailed.ok, false);
    assert.match(detailed.error, /at node 'build': TypeError/);

    const generic = smithersRunOutcome({
      capability: { slug: "hello" },
      state: "errored",
      sid: "run-6",
      inspect: {},
      eventLines: []
    });
    assert.deepEqual(generic, {
      ok: false,
      error: "smithers run run-6 ended in state 'errored'",
      status: ""
    });
  });
});
