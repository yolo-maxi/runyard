import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachChainToInput,
  chainMetadata,
  nextChainedRunInput,
  nextChainedRunOrigin,
  normalizeChainSteps
} from "../src/workflowChain.js";

describe("workflow chain helpers", () => {
  it("normalizes string and object chain steps", () => {
    assert.deepEqual(
      normalizeChainSteps([
        "hello",
        { capabilitySlug: "research", input: { prompt: "x" }, title: "Research", passPreviousOutput: false },
        { slug: "deploy", input: ["bad"] },
        { input: { missing: true } },
        null
      ]),
      [
        { capability: "hello", input: {} },
        { capability: "research", input: { prompt: "x" }, title: "Research", passPreviousOutput: false },
        { capability: "deploy", input: {}, title: "", passPreviousOutput: true }
      ]
    );
  });

  it("caps normalized chains at twenty steps", () => {
    assert.equal(normalizeChainSteps(Array.from({ length: 25 }, (_, index) => `step-${index}`)).length, 20);
  });

  it("reads chain metadata from public or internal fields", () => {
    assert.deepEqual(chainMetadata({ chain: ["a"], __chainIndex: "-3" }), {
      chain: [{ capability: "a", input: {} }],
      index: 0
    });
    assert.deepEqual(chainMetadata({ __chain: ["b"], __chainIndex: "2" }), {
      chain: [{ capability: "b", input: {} }],
      index: 2
    });
  });

  it("attaches normalized chains to mutable run input objects", () => {
    const input = { goal: "first" };
    assert.equal(attachChainToInput(input, [{ capability: "next" }]), input);
    assert.deepEqual(input.__chain, [{ capability: "next", input: {}, title: "", passPreviousOutput: true }]);
    assert.equal(input.__chainIndex, 0);
    assert.deepEqual(attachChainToInput(["bad"], ["next"]), ["bad"]);
  });

  it("builds next-run input with parent metadata and optional output forwarding", () => {
    const parentRun = {
      id: "run 1",
      capabilitySlug: "research",
      capabilityName: "Research",
      status: "succeeded",
      output: { fallback: true }
    };
    const chain = [{ capability: "hello", input: { goal: "second" } }];
    assert.deepEqual(nextChainedRunInput({
      parentRun,
      output: { answer: 42 },
      chain,
      index: 0,
      next: chain[0]
    }), {
      goal: "second",
      __chain: chain,
      __chainIndex: 1,
      previousRun: {
        id: "run 1",
        capabilitySlug: "research",
        capabilityName: "Research",
        status: "succeeded",
        deepLink: "/app#runs/run%201"
      },
      previousOutput: { answer: 42 }
    });

    assert.equal("previousOutput" in nextChainedRunInput({
      parentRun,
      chain,
      index: 0,
      next: { capability: "hello", input: {}, passPreviousOutput: false }
    }), false);
  });

  it("builds audit origin metadata for chained runs", () => {
    assert.deepEqual(nextChainedRunOrigin({ id: "run_1", capabilitySlug: "research" }, ["a", "b"], 1), {
      label: "Chained from research run_1",
      type: "workflow-chain",
      parentRunId: "run_1",
      chainIndex: 2,
      chainLength: 2
    });
  });
});
