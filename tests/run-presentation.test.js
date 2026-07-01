import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildQueueIndex,
  cleanStringList,
  deriveRunDescription,
  deriveRunTitle,
  hasNoChangeReviewRationale,
  normalizeSupervisionLineage,
  runOutcomeSummary,
  runPresentation,
  withRunLinks
} from "../src/runPresentation.js";
import { SUPERVISION_CHILD_KEY, SUPERVISOR_CAPABILITY_SLUG } from "../src/supervision.js";

describe("run presentation helpers", () => {
  it("derives titles and descriptions from inputs before fallbacks", () => {
    assert.equal(deriveRunTitle({ capabilityName: "Research", input: { title: " Ship it " } }), "Ship it");
    assert.equal(deriveRunTitle({ capabilitySlug: "hello", input: {} }), "hello");
    assert.equal(deriveRunDescription({ capabilityName: "Research", currentStep: "running", input: {} }), "Research — running");
    assert.equal(deriveRunDescription({ input: { description: "Detailed scope" } }), "Detailed scope");
  });

  it("normalizes supervision lineage from arrays and JSON strings", () => {
    assert.deepEqual(normalizeSupervisionLineage([{ id: 1 }]), [{ id: 1 }]);
    assert.deepEqual(normalizeSupervisionLineage('[{"id":1}]'), [{ id: 1 }]);
    assert.deepEqual(normalizeSupervisionLineage("bad json"), []);
  });

  it("normalizes outcome string lists and no-change review rationale", () => {
    assert.deepEqual(cleanStringList([" a.js ", "", null, "b.js"]), ["a.js", "b.js"]);
    assert.deepEqual(cleanStringList("not an array"), []);
    assert.equal(hasNoChangeReviewRationale({ improvements: ["done"], risks: ["still risky"] }), false);
    assert.equal(hasNoChangeReviewRationale({ improvements: [], risks: [" needs review "] }), true);
    assert.equal(hasNoChangeReviewRationale({ summary: "No changes needed" }), true);
    assert.equal(hasNoChangeReviewRationale({ improvements: [], risks: [" "] }), false);
  });

  it("unwraps supervised runs for presentation without exposing internals", () => {
    const child = { id: "child", output: { result: "done" } };
    const presented = runPresentation(
      {
        id: "parent",
        capabilitySlug: SUPERVISOR_CAPABILITY_SLUG,
        capabilityName: "Run Smithers",
        input: {
          __supervisionToken: "secret",
          wrappedCapability: "improve",
          wrappedInput: { prompt: "fix", [SUPERVISION_CHILD_KEY]: { token: "hidden" } }
        },
        output: { outputs: { supervise: { wrappedRunId: "child", outcome: "completed", lineage: '[{"runId":"child"}]' } } }
      },
      {
        getCapability: (slug) => ({ slug, name: "Improve" }),
        getRun: (id) => (id === "child" ? child : null)
      }
    );

    assert.equal(presented.run.capabilitySlug, "improve");
    assert.equal(presented.run.capabilityName, "Improve");
    assert.deepEqual(presented.input, { prompt: "fix" });
    assert.deepEqual(presented.output, { result: "done" });
    assert.equal(presented.supervision.childRunId, "child");
    assert.equal(presented.supervision.attempts, 1);
  });

  it("summarizes work products from structured workflow output", () => {
    assert.deepEqual(
      runOutcomeSummary({
        status: "succeeded",
        output: {
          outputs: {
            baseline: { repoDir: "/repo" },
            commit: { files: [" a.js ", "", "b.js"], stat: " 2 files changed, 4 insertions(+), 1 deletion(-)" },
            review: { improvements: ["done"] }
          }
        }
      }),
      {
        repo: "/repo",
        changedFiles: 2,
        files: ["a.js", "b.js"],
        churn: { additions: 4, deletions: 1 },
        digest: "In this run, we updated a.js and b.js.",
        workProduct: "2 changed files",
        classification: "succeeded"
      }
    );
  });

  it("decorates runs with links, origin, queue metadata, and visible fields", () => {
    const queue = buildQueueIndex([
      { id: "later", status: "queued", createdAt: "2026-01-01T00:00:02.000Z" },
      { id: "run 1", status: "queued", createdAt: "2026-01-01T00:00:01.000Z" }
    ]);
    const decorated = withRunLinks(
      {
        id: "run 1",
        status: "queued",
        capabilitySlug: "research",
        capabilityName: "Research",
        input: {
          prompt: "Investigate",
          context: { project: "Runyard", branch: "main" },
          __origin: { type: "telegram", name: "ops" }
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:03.000Z"
      },
      queue
    );

    assert.equal(decorated.title, "Investigate");
    assert.equal(decorated.project, "Runyard");
    assert.equal(decorated.branch, "main");
    assert.equal(decorated.originLabel, "ops");
    assert.deepEqual(decorated.queue, { position: 1, total: 2 });
    assert.equal(decorated.durationMs, 2000);
    assert.equal(decorated.deepLink, "/app#runs/run%201");
    assert.equal(decorated.deepLinkWorkflow, "/app#workflows/research");
  });
});
