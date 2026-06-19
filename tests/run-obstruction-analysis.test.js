import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRunObstructionAnalysisArtifact,
  buildRunObstructionAnalysisRequest,
  RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME,
  RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION
} from "../src/runObstructionAnalysis.js";

function warningRun() {
  return {
    generatedAt: "2026-06-19T00:00:00.000Z",
    run: {
      id: "run_obstruction_test",
      status: "succeeded",
      capabilitySlug: "hello",
      capabilityName: "Hello",
      workflowVersion: 1,
      runnerId: "runner_test",
      currentStep: "retrying after token=shub_supersecret",
      input: {
        prompt: "raw user goal prompt should never appear",
        env: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz"
      },
      output: { secretOutput: "raw output value should never appear" },
      createdAt: "2026-06-19T00:00:00.000Z",
      assignedAt: "2026-06-19T00:00:01.000Z",
      startedAt: "2026-06-19T00:00:02.000Z",
      completedAt: "2026-06-19T00:22:05.000Z",
      deepLink: "/app#runs/run_obstruction_test"
    },
    capability: {
      slug: "hello",
      name: "Hello",
      version: 1,
      workflow: { engine: "smithers", entry: ".smithers/workflows/hello.tsx" },
      requiredRunnerTags: ["smithers"],
      requiredSkills: ["research-method"],
      requiredAgents: []
    },
    artifacts: [
      {
        id: "art_result",
        name: "result.md",
        mimeType: "text/markdown",
        sizeBytes: 5000,
        createdAt: "2026-06-19T00:21:00.000Z",
        metadata: { generatedBy: "smithers-runner", token: "ghp_abcdefghijklmnopqrstuvwxyz" }
      }
    ],
    logSummary: {
      totals: { events: 80, highlights: 4, errors: 0, warnings: 2 },
      categories: [{ key: "log", count: 70 }, { key: "run", count: 4 }],
      severities: [{ key: "warn", count: 2 }, { key: "info", count: 78 }],
      types: [{ key: "stderr", count: 2, category: "log" }],
      highlights: [
        {
          type: "stderr",
          category: "log",
          severity: "warn",
          message: `Retrying after API key OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz ${"x".repeat(6000)}`,
          createdAt: "2026-06-19T00:05:00.000Z"
        },
        {
          type: "run.succeeded",
          category: "run",
          severity: "info",
          message: "Run completed after retry",
          createdAt: "2026-06-19T00:22:05.000Z"
        }
      ]
    }
  };
}

describe("run obstruction analysis artifacts", () => {
  it("builds a bounded redacted analyzer request without raw input or output values", () => {
    const request = buildRunObstructionAnalysisRequest(warningRun(), { maxPromptChars: 2600 });
    assert.ok(request, "warning/retry evidence should be enough for analysis");
    assert.ok(request.promptPayload.length <= 2600);
    assert.equal(request.promptPayload.includes("shub_supersecret"), false);
    assert.equal(request.promptPayload.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(request.promptPayload.includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(request.promptPayload.includes("raw user goal prompt should never appear"), false);
    assert.equal(request.promptPayload.includes("raw output value should never appear"), false);
    assert.equal(request.payload.redaction.rawInputsIncluded, false);
    assert.equal(request.payload.redaction.rawOutputsIncluded, false);
    assert.equal(request.payload.redaction.artifactContentsIncluded, false);
    assert.deepEqual(request.payload.run.inputShape.keys, ["prompt", "env"]);
    assert.deepEqual(request.payload.run.outputShape.keys, ["secretOutput"]);
  });

  it("normalizes artifact-only analysis output and caps confidence for thin evidence", () => {
    const request = buildRunObstructionAnalysisRequest(warningRun());
    request.payload.evidence.quality = "thin";
    const artifact = buildRunObstructionAnalysisArtifact({
      payload: request.payload,
      analyzer: { provider: "test", model: "fake" },
      rawAnalysis: {
        severity: "medium",
        confidence: "high",
        summary: "Retry made a successful run slower than expected.",
        observations: [
          {
            evidence: "stderr warning and retry signal",
            inference: "The workflow had transient tool friction.",
            severity: "low",
            confidence: "high"
          }
        ],
        obstructions: [],
        suggestedWorkflowImprovements: ["Add a retry summary to workflow output."],
        suggestedAgentImprovements: ["Report retry counts in the final message."],
        suggestedSkillOrKnowledgeImprovements: ["Document the flaky command workaround."],
        followUpQuestions: ["Was the retry expected for this runner?"],
        doNotAutoMutate: false
      }
    });

    assert.equal(artifact.name, RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME);
    assert.equal(artifact.mimeType, "application/json");
    assert.equal(artifact.metadata.schemaVersion, RUN_OBSTRUCTION_ANALYSIS_SCHEMA_VERSION);
    const content = JSON.parse(artifact.content);
    assert.equal(content.policy.artifactOnly, true);
    assert.equal(content.policy.autoMutations, false);
    assert.deepEqual(content.policy.mutatedSoftAssets, []);
    assert.equal(content.doNotAutoMutate, true);
    assert.equal(content.confidence.level, "low");
    assert.equal(content.observations[0].confidence, "low");
    assert.equal(content.observations[0].evidence, "stderr warning and retry signal");
    assert.equal(content.observations[0].inference, "The workflow had transient tool friction.");
    assert.deepEqual(content.suggestedWorkflowImprovements, ["Add a retry summary to workflow output."]);
  });
});
