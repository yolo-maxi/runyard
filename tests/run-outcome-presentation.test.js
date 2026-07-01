import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanStringList,
  hasNoChangeReviewRationale,
  outputNode,
  runOutcomeSummary
} from "../src/runOutcomePresentation.js";

describe("run outcome presentation helpers", () => {
  it("finds structured output nodes", () => {
    assert.deepEqual(outputNode({ outputs: { commit: { files: [] } } }, "commit"), { files: [] });
    assert.deepEqual(outputNode({ commit: { files: [] } }, "commit"), { files: [] });
    assert.equal(outputNode(null, "commit"), null);
    assert.equal(outputNode({ outputs: { commit: [] } }, "commit"), null);
  });

  it("normalizes outcome lists and no-change rationale", () => {
    assert.deepEqual(cleanStringList([" a.js ", "", null, "b.js"]), ["a.js", "b.js"]);
    assert.deepEqual(cleanStringList("not an array"), []);
    assert.equal(hasNoChangeReviewRationale({ improvements: ["done"], risks: ["still risky"] }), false);
    assert.equal(hasNoChangeReviewRationale({ improvements: [], risks: [" needs review "] }), true);
    assert.equal(hasNoChangeReviewRationale({ summary: "No changes needed" }), true);
    assert.equal(hasNoChangeReviewRationale({ improvements: [], risks: [" "] }), false);
  });

  it("summarizes changed files, no-change reviews, output-only runs, and empty outputs", () => {
    assert.deepEqual(runOutcomeSummary({
      status: "succeeded",
      output: {
        outputs: {
          baseline: { repoDir: "/repo" },
          commit: { files: [" a.js ", "", "b.js"] },
          review: { improvements: ["done"] }
        }
      }
    }), {
      repo: "/repo",
      changedFiles: 2,
      files: ["a.js", "b.js"],
      workProduct: "2 changed files",
      classification: "succeeded"
    });

    assert.equal(runOutcomeSummary({
      output: { outputs: { review: { summary: "no changes needed" } } }
    }).workProduct, "explicit no-change review");
    assert.equal(runOutcomeSummary({ output: { ok: true } }).workProduct, "output only");
    assert.equal(runOutcomeSummary({ project: "repo" }).workProduct, "none");
  });
});
