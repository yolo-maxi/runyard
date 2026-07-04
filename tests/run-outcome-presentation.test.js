import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanStringList,
  collectChangedFiles,
  collectCodeChurn,
  hasNoChangeReviewRationale,
  outputNode,
  parseGitDiffStat,
  runOutcomeDigest,
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
      churn: null,
      digest: "In this run, we updated a.js and b.js.",
      workProduct: "2 changed files",
      classification: "succeeded",
      hooks: null
    });

    assert.equal(runOutcomeSummary({
      output: { outputs: { review: { summary: "no changes needed" } } }
    }).workProduct, "explicit no-change review");
    assert.equal(runOutcomeSummary({ output: { ok: true } }).workProduct, "output only");
    const emptyRun = runOutcomeSummary({ project: "repo" });
    assert.equal(emptyRun.workProduct, "none");
    // Old runs (no output) stay graceful — churn is null, digest is empty.
    assert.equal(emptyRun.churn, null);
    assert.equal(emptyRun.digest, "");
  });

  it("collects changed files from commit, implement, and workflow-doctor node keys", () => {
    assert.deepEqual(collectChangedFiles(null), []);
    assert.deepEqual(
      collectChangedFiles({
        outputs: {
          commit: { files: ["a.js", "b.js"] },
          implement: { changedFiles: ["b.js", "c.js"] },
          "workflow-doctor": { changedFiles: ["d.js"] }
        }
      }),
      ["a.js", "b.js", "c.js", "d.js"]
    );
    assert.deepEqual(
      collectChangedFiles({ filesChanged: ["envelope.js"], outputs: { implement: { changedFiles: ["node.js"] } } }),
      ["envelope.js", "node.js"]
    );
  });

  it("trusts the runner-stamped changeSummary.files even when per-node keys have drifted", () => {
    // Terminal artifact / run envelope carries `changeSummary` as the persisted
    // source of truth; the Runs UI should reflect that count directly instead
    // of showing zero when the per-node shape doesn't match GENERIC_CHANGED_FILE_KEYS.
    assert.deepEqual(
      collectChangedFiles({
        changeSummary: { changedFileCount: 2, files: ["a.js", "b.js"], churn: null },
        outputs: { implement: { files_modified: ["a.js", "b.js"] } }
      }),
      ["a.js", "b.js"]
    );
    // Unions cleanly with per-node evidence — no double counting.
    assert.deepEqual(
      collectChangedFiles({
        changeSummary: { files: ["a.js"] },
        outputs: { commit: { files: ["a.js", "b.js"] } }
      }),
      ["a.js", "b.js"]
    );
  });

  it("reports the real changed-file count for workflows that use non-commit output keys", () => {
    assert.deepEqual(
      runOutcomeSummary({
        status: "succeeded",
        output: { outputs: { implement: { changedFiles: ["a.js", "b.js"] } } }
      }),
      {
        repo: "unresolved",
        changedFiles: 2,
        files: ["a.js", "b.js"],
        churn: null,
        digest: "In this run, we updated a.js and b.js.",
        workProduct: "2 changed files",
        classification: "succeeded",
        hooks: null
      }
    );
  });

  it("parses the trailing footer of `git diff --stat` for GitHub-style churn", () => {
    assert.equal(parseGitDiffStat(""), null);
    assert.equal(parseGitDiffStat(null), null);
    assert.deepEqual(
      parseGitDiffStat(" src/foo.js | 5 +++--\n 2 files changed, 8 insertions(+), 12 deletions(-)"),
      { additions: 8, deletions: 12 }
    );
    // insertion-only run — the footer omits the deletion clause entirely.
    assert.deepEqual(
      parseGitDiffStat(" 1 file changed, 3 insertions(+)"),
      { additions: 3, deletions: 0 }
    );
    // deletion-only run.
    assert.deepEqual(
      parseGitDiffStat(" 1 file changed, 2 deletions(-)"),
      { additions: 0, deletions: 2 }
    );
    // Falls back to summing per-file +/- markers when the footer is absent.
    assert.deepEqual(
      parseGitDiffStat(" src/foo.js | 5 +++--\n src/bar.js | 2 +-"),
      { additions: 4, deletions: 3 }
    );
    // `git diff --numstat` fallback: TAB-separated <adds>\t<dels>\t<path>,
    // with `-\t-` for binary files (which contribute nothing to line churn).
    assert.deepEqual(
      parseGitDiffStat("5\t12\tsrc/foo.js\n3\t0\tsrc/bar.js\n-\t-\tpublic/logo.png"),
      { additions: 8, deletions: 12 }
    );
  });

  it("collects code churn from commit.stat, explicit numeric fields, and per-node payloads", () => {
    assert.equal(collectCodeChurn(null), null);
    assert.deepEqual(
      collectCodeChurn({ outputs: { commit: { stat: " 1 file changed, 4 insertions(+), 1 deletion(-)" } } }),
      { additions: 4, deletions: 1 }
    );
    // Explicit envelope-level churn wins over commit.stat.
    assert.deepEqual(
      collectCodeChurn({ churn: { additions: 9, deletions: 2 }, outputs: { commit: { stat: "ignored" } } }),
      { additions: 9, deletions: 2 }
    );
    // A per-node churn payload is enough — the envelope doesn't have to expose it.
    assert.deepEqual(
      collectCodeChurn({ outputs: { implement: { churn: { insertions: 3, deletions: 0 } } } }),
      { additions: 3, deletions: 0 }
    );
    // Numstat-style output on a per-node payload is also honored, so workflows
    // that emit `git diff --numstat` (easier to parse than --stat) still surface
    // churn to the UI.
    assert.deepEqual(
      collectCodeChurn({ outputs: { commit: { numstat: "5\t12\tsrc/foo.js" } } }),
      { additions: 5, deletions: 12 }
    );
    assert.deepEqual(
      collectCodeChurn({ outputs: { implement: { numstat: "1\t0\tsrc/only-added.js" } } }),
      { additions: 1, deletions: 0 }
    );
    // A run that did not touch code stays null so the UI can hide the chip.
    assert.equal(
      collectCodeChurn({ outputs: { review: { summary: "no changes needed" } } }),
      null
    );
    // The runner stamps `changeSummary.churn` on every terminal run — read the
    // nested churn block instead of misinterpreting the wrapper as a churn
    // record. Before this fix the wrapper (with `changedFileCount`/`files`/
    // `churn`) always failed `normalizeChurn` at the top level, so the Runs UI
    // fell back to zero churn whenever per-node re-derivation missed.
    assert.deepEqual(
      collectCodeChurn({
        changeSummary: { changedFileCount: 2, files: ["a.js", "b.js"], churn: { additions: 6, deletions: 1 } }
      }),
      { additions: 6, deletions: 1 }
    );
  });

  it("builds a one-sentence digest from implement.summary / files and flags deploy verification", () => {
    assert.equal(runOutcomeDigest(null, []), "");
    // Explicit implement summary takes precedence.
    assert.equal(
      runOutcomeDigest({ outputs: { implement: { summary: "Refactored the runner state machine." } } }, ["a.js"]),
      "Refactored the runner state machine."
    );
    // Fallback to a file-list sentence when no summary exists.
    assert.equal(
      runOutcomeDigest({ outputs: { commit: { files: ["a.js", "b.js"] } } }, ["a.js", "b.js"]),
      "In this run, we updated a.js and b.js."
    );
    // Deploy verify hint appends "needs manual verification" so operators know
    // to eyeball the change post-deploy.
    assert.equal(
      runOutcomeDigest(
        { outputs: {
          implement: { summary: "Improved the RunYard UI." },
          deploy: { verify: "hub /api/health" }
        } },
        []
      ),
      "Improved the RunYard UI; hub /api/health needs manual verification."
    );
    // Old runs / non-code runs — return "" so the UI can hide the digest.
    assert.equal(runOutcomeDigest({}, []), "");
  });
});
