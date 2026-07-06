import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanRerunInput,
  findActiveDuplicateRerun,
  logicalRerunInput,
  rerunFingerprint
} from "../src/runRerun.js";

describe("run rerun helpers", () => {
  it("fingerprints inputs independent of key order", () => {
    assert.equal(rerunFingerprint({ b: 2, a: 1 }), rerunFingerprint({ a: 1, b: 2 }));
  });

  it("extracts logical input from direct runs", () => {
    assert.deepEqual(logicalRerunInput({
      capabilitySlug: "hello",
      input: { prompt: "x", __origin: { label: "old" } }
    }), {
      capabilitySlug: "hello",
      input: { prompt: "x" },
      isSupervisor: false
    });
  });

  it("finds active duplicate reruns", () => {
    const input = { prompt: "again", rerunOf: "run_old" };
    const direct = { id: "direct", status: "queued", capabilitySlug: "improve", input };
    const inactive = { id: "done", status: "succeeded", capabilitySlug: "improve", input };

    assert.equal(findActiveDuplicateRerun([inactive, direct], {
      previousRunId: "run_old",
      capabilitySlug: "improve",
      input
    }).id, "direct");
  });

  it("cleans rerun input internals and stamps rerunOf", () => {
    assert.deepEqual(cleanRerunInput({
      prompt: "again",
      __origin: { label: "old" }
    }, "run_old"), {
      prompt: "again",
      rerunOf: "run_old"
    });
  });
});
