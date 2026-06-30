import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanRerunInput,
  findActiveDuplicateRerun,
  logicalRerunInput,
  rerunFingerprint
} from "../src/runRerun.js";
import { SUPERVISION_CHILD_KEY, SUPERVISION_TOKEN_KEY, SUPERVISOR_CAPABILITY_SLUG } from "../src/supervision.js";

describe("run rerun helpers", () => {
  it("fingerprints inputs independent of key order", () => {
    assert.equal(rerunFingerprint({ b: 2, a: 1 }), rerunFingerprint({ a: 1, b: 2 }));
  });

  it("extracts logical input from direct and supervised runs", () => {
    assert.deepEqual(logicalRerunInput({
      capabilitySlug: "hello",
      input: { prompt: "x", __origin: { label: "old" }, [SUPERVISION_CHILD_KEY]: { token: "hidden" } }
    }), {
      capabilitySlug: "hello",
      input: { prompt: "x" },
      isSupervisor: false
    });

    assert.deepEqual(logicalRerunInput({
      capabilitySlug: SUPERVISOR_CAPABILITY_SLUG,
      input: {
        [SUPERVISION_TOKEN_KEY]: "token",
        wrappedCapability: "improve",
        wrappedInput: { goal: "fix", __origin: { label: "old" } }
      }
    }), {
      capabilitySlug: "improve",
      input: { goal: "fix" },
      isSupervisor: true
    });
  });

  it("prefers active supervised duplicates over direct duplicates", () => {
    const input = { prompt: "again", rerunOf: "run_old" };
    const direct = { id: "direct", status: "queued", capabilitySlug: "improve", input };
    const supervised = {
      id: "supervised",
      status: "running",
      capabilitySlug: SUPERVISOR_CAPABILITY_SLUG,
      input: {
        [SUPERVISION_TOKEN_KEY]: "token",
        wrappedCapability: "improve",
        wrappedInput: input
      }
    };
    const inactive = { id: "done", status: "succeeded", capabilitySlug: "improve", input };

    assert.equal(findActiveDuplicateRerun([inactive, direct, supervised], {
      previousRunId: "run_old",
      capabilitySlug: "improve",
      input
    }).id, "supervised");
  });

  it("cleans rerun input internals and stamps rerunOf", () => {
    assert.deepEqual(cleanRerunInput({
      prompt: "again",
      __origin: { label: "old" },
      [SUPERVISION_TOKEN_KEY]: "secret",
      [SUPERVISION_CHILD_KEY]: { token: "secret" }
    }, "run_old"), {
      prompt: "again",
      rerunOf: "run_old"
    });
  });
});
