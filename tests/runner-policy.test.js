import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RUN_FAILURE_CLASSES } from "../src/runFailureClass.js";
import {
  hasExplicitNoChangeRationale,
  largeInputPayload,
  productiveOutcomeFailure,
  runSmithersSupervisionFailure
} from "../src/runnerPolicy.js";

describe("runner policy helpers", () => {
  it("keeps small input inline and moves large input to stdin", () => {
    assert.deepEqual(largeInputPayload({ ok: true }, 100), { inline: "{\"ok\":true}", stdin: "" });
    const large = largeInputPayload({ text: "x".repeat(20) }, 10);
    assert.equal(large.inline, "");
    assert.match(large.stdin, /"text"/);
  });

  it("recognizes explicit no-change review rationale", () => {
    assert.equal(hasExplicitNoChangeRationale({ improvements: [], summary: "No change needed." }), true);
    assert.equal(hasExplicitNoChangeRationale({ improvements: [], risks: ["No issue found."] }), true);
    assert.equal(hasExplicitNoChangeRationale({ improvements: ["change file"], summary: "No-op" }), false);
    assert.equal(hasExplicitNoChangeRationale(null), false);
  });

  it("rejects empty workflow outputs before reporting success", () => {
    assert.deepEqual(productiveOutcomeFailure({ slug: "hello" }, {}), {
      status: RUN_FAILURE_CLASSES.INVALID_OUTPUT,
      error: "invalid output: succeeded workflow produced no node outputs"
    });
    assert.equal(productiveOutcomeFailure({ slug: "hello" }, { greet: { ok: true } }), null);
  });

  it("rejects no-op Improve outputs without target repo or rationale", () => {
    assert.deepEqual(productiveOutcomeFailure({ slug: "improve" }, { baseline: {} }), {
      status: RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT,
      error: "preflight failed: improve completed without a resolved target repo"
    });
    assert.deepEqual(productiveOutcomeFailure({ slug: "improve" }, { baseline: { repoDir: "/repo" }, commit: { files: [] } }), {
      status: RUN_FAILURE_CLASSES.INVALID_OUTPUT,
      error: "invalid output: improve succeeded without changed files or an explicit no-change rationale"
    });
    assert.equal(productiveOutcomeFailure({ slug: "improve" }, { baseline: { repo_dir: "/repo" }, commit: { files: ["a.js"] } }), null);
    assert.equal(
      productiveOutcomeFailure(
        { slug: "improve" },
        { baseline: { repoDir: "/repo" }, commit: { files: [] }, review: { improvements: [], summary: "Already clean." } }
      ),
      null
    );
  });

  it("surfaces run-smithers non-success outcomes as runner failures", () => {
    assert.equal(runSmithersSupervisionFailure({ slug: "hello" }, { supervise: { outcome: "needs_recovery" } }), "");
    assert.equal(runSmithersSupervisionFailure({ slug: "run-smithers" }, { supervise: { outcome: "succeeded" } }), "");
    assert.match(
      runSmithersSupervisionFailure({ slug: "run-smithers" }, { supervise: { outcome: "needs_recovery", summary: "child failed" } }),
      /needs_recovery.*child failed/
    );
  });
});
