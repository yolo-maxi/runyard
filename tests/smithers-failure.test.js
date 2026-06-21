import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractSmithersFailure } from "../src/smithersFailure.js";

describe("extractSmithersFailure", () => {
  it("pulls the failing node id + stack from a failed step (product-workflow dispatch repro)", () => {
    // Mirrors the real product-workflow failure: dispatch threw a TypeError from
    // renderReport reading research.competitors.length on an undefined output.
    const state = {
      runState: { state: "failed" },
      steps: [
        { id: "baseline", state: "succeeded" },
        { id: "research", state: "succeeded" },
        { id: "featureMap", state: "succeeded" },
        { id: "prioritize", state: "succeeded" },
        {
          id: "dispatch",
          state: "failed",
          error: {
            message: "Cannot read properties of undefined (reading 'competitors')",
            stack:
              "TypeError: Cannot read properties of undefined (reading 'competitors')\n" +
              "    at renderReport (.smithers/workflows/product-workflow.tsx:237:42)"
          }
        }
      ]
    };
    const failure = extractSmithersFailure(state, []);
    assert.equal(failure.failedStep, "dispatch");
    assert.match(failure.error, /TypeError/);
    assert.match(failure.error, /product-workflow\.tsx:237/);
  });

  it("falls back to the last error-ish event line when state has no node error", () => {
    const state = { runState: { state: "failed" }, steps: [{ id: "build", state: "running" }] };
    const events = [
      JSON.stringify({ data: "starting build" }),
      JSON.stringify({ data: "ReferenceError: foo is not defined at workflow.js:10:3" }),
      JSON.stringify({ data: "cleanup" })
    ];
    const failure = extractSmithersFailure(state, events);
    assert.match(failure.error, /ReferenceError: foo is not defined/);
  });

  it("prefers a NodeFailed workflow error over a generic RunFailed scheduler wrapper", () => {
    const state = {
      runState: {
        state: "failed",
        error: {
          stack: "Error\n    at unhandledFailureDecision (/node_modules/@smithers-orchestrator/scheduler/src/makeWorkflowSession.js:397:32)"
        }
      }
    };
    const events = [
      JSON.stringify({
        type: "NodeFailed",
        payload: {
          nodeId: "dispatch",
          error: {
            name: "TypeError",
            message:
              "product-workflow research produced no structured items; refusing to report a successful zero-feature plan.",
            stack:
              "TypeError: product-workflow research produced no structured items; refusing to report a successful zero-feature plan.\n" +
              "    at requireNonEmptyStage (/home/xiko/smithers-workspace/.smithers/workflows/product-workflow.tsx:296:13)"
          }
        }
      }),
      JSON.stringify({
        type: "RunFailed",
        payload: {
          error: {
            stack: "Error\n    at unhandledFailureDecision (/node_modules/@smithers-orchestrator/scheduler/src/makeWorkflowSession.js:397:32)"
          }
        }
      })
    ];
    const failure = extractSmithersFailure(state, events);
    assert.equal(failure.failedStep, "dispatch");
    assert.match(failure.error, /product-workflow research produced no structured items/);
    assert.match(failure.error, /product-workflow\.tsx:296/);
    assert.doesNotMatch(failure.error, /unhandledFailureDecision/);
  });

  it("returns empty error when there is no failure signal", () => {
    const state = { runState: { state: "succeeded" }, steps: [{ id: "a", state: "succeeded" }] };
    const failure = extractSmithersFailure(state, ["all good"]);
    assert.equal(failure.error, "");
    assert.equal(failure.failedStep, "");
  });

  it("caps very long stacks so the run error stays bounded", () => {
    const state = { steps: [{ id: "x", state: "failed", error: "TypeError: " + "x".repeat(5000) }] };
    const failure = extractSmithersFailure(state, []);
    assert.ok(failure.error.length <= 2000);
  });
});
