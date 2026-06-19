import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownArtifactsFromOutputs } from "../src/runnerArtifacts.js";

describe("Smithers runner report artifacts", () => {
  it("extracts Markdown report outputs into safe artifact uploads", () => {
    const artifacts = markdownArtifactsFromOutputs({
      gather: { ok: true },
      report: {
        artifactName: "../run-knowledge-report",
        report: "# Run Knowledge Report\n\nEvidence-backed recommendations."
      },
      summary: {
        artifact_name: "run-knowledge-report.md",
        markdown: "## Second report"
      }
    });

    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0].name, "..-run-knowledge-report.md");
    assert.equal(artifacts[0].mimeType, "text/markdown");
    assert.equal(artifacts[0].metadata.sourceNode, "report");
    assert.equal(artifacts[0].metadata.sourceField, "report");
    assert.equal(artifacts[1].name, "run-knowledge-report.md");
  });

  it("deduplicates requested artifact names and ignores empty report fields", () => {
    const artifacts = markdownArtifactsFromOutputs({
      first: { artifactName: "report.md", report: "One" },
      second: { artifactName: "report.md", report: "Two" },
      empty: { artifactName: "empty.md", report: "  " }
    });

    assert.deepEqual(artifacts.map((artifact) => artifact.name), ["report.md", "report-2.md"]);
  });
});
