import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRunRetrospectiveArtifact,
  RUN_RETROSPECTIVE_ARTIFACT_NAME,
  RUN_RETROSPECTIVE_SCHEMA_VERSION
} from "../src/runRetrospective.js";

describe("run retrospective artifacts", () => {
  it("builds a lightweight artifact without raw input or output values", () => {
    const artifact = buildRunRetrospectiveArtifact({
      generatedAt: "2026-06-19T00:00:00.000Z",
      run: {
        id: "run_test",
        status: "succeeded",
        title: "Test run",
        description: "A concise run description",
        capabilitySlug: "hello",
        capabilityName: "Hello",
        workflowVersion: 3,
        runnerId: "runner_test",
        currentStep: "completed",
        input: { token: "shub_secret", goal: "do work" },
        output: { smithersRunId: "run-123", nested: { secret: "value" } },
        createdAt: "2026-06-19T00:00:00.000Z",
        assignedAt: "2026-06-19T00:00:01.000Z",
        startedAt: "2026-06-19T00:00:02.000Z",
        completedAt: "2026-06-19T00:00:05.000Z",
        deepLink: "/app#runs/run_test"
      },
      capability: {
        slug: "hello",
        name: "Hello",
        version: 3,
        workflow: { engine: "smithers", entry: ".smithers/workflows/hello.tsx" },
        requiredRunnerTags: ["smithers"],
        requiredSkills: ["research-method"],
        requiredAgents: [],
        deepLink: "/app#workflows/hello"
      },
      artifacts: [
        {
          id: "art_result",
          name: "result.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
          createdAt: "2026-06-19T00:00:04.000Z",
          deepLink: "/app#runs/run_test/artifacts/art_result",
          metadata: { generatedBy: "smithers-runner", sourceNode: "report", token: "secret" }
        },
        { name: RUN_RETROSPECTIVE_ARTIFACT_NAME }
      ],
      logSummary: {
        totals: { events: 4, highlights: 1, errors: 0, warnings: 0 },
        highlights: [{ id: "evt_1", type: "run.succeeded", category: "run", severity: "info", message: "Run completed" }]
      }
    });

    assert.equal(artifact.name, RUN_RETROSPECTIVE_ARTIFACT_NAME);
    assert.equal(artifact.mimeType, "application/json");
    assert.equal(artifact.metadata.schemaVersion, RUN_RETROSPECTIVE_SCHEMA_VERSION);
    const content = JSON.parse(artifact.content);
    assert.equal(content.schemaVersion, RUN_RETROSPECTIVE_SCHEMA_VERSION);
    assert.equal(content.policy.autoMutations, false);
    assert.deepEqual(content.policy.mutatedSoftAssets, []);
    assert.equal(content.run.id, "run_test");
    assert.equal(content.workflow.entry, ".smithers/workflows/hello.tsx");
    assert.equal(content.timing.executionMs, 3000);
    assert.equal(content.evidence.artifactInventory.length, 1);
    assert.deepEqual(content.evidence.artifactInventory[0].metadata, {
      generatedBy: "smithers-runner",
      sourceNode: "report"
    });
    assert.deepEqual(content.evidence.outputShape.fields.nested, { type: "object", keys: ["secret"], fields: {} });
    assert.equal(artifact.content.includes("shub_secret"), false);
    assert.equal(artifact.content.includes("do work"), false);
    assert.equal(artifact.content.includes('"value"'), false);
  });
});
