import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  SMITHERS_SAMPLES_REFERENCE,
  classifySmithersProcessExit,
  lintSmithersWorkflowSource
} from "../src/smithersHardening.js";

describe("Smithers samples hardening guardrails", () => {
  it("documents the imported samples as reference patterns, not vendored code", () => {
    assert.equal(SMITHERS_SAMPLES_REFERENCE.repository, "https://github.com/dennisonbertram/smithers-samples");
    assert.ok(SMITHERS_SAMPLES_REFERENCE.samples.some((sample) => sample.slug === "durable-fix-until-green"));
    assert.ok(SMITHERS_SAMPLES_REFERENCE.samples.some((sample) => sample.slug === "cost-aware-model-router"));
  });

  it("ships the preferred runyard CLI alias while preserving legacy bins", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    assert.equal(pkg.bin.runyard, "./bin/smithers-hub.js");
    assert.equal(pkg.bin["smithers-hub"], "./bin/smithers-hub.js");
    assert.equal(pkg.bin["smithers-hub-mcp"], "./bin/smithers-hub-mcp.js");
  });

  it("treats Smithers approval exit code 3 as paused, not failed", () => {
    assert.deepEqual(classifySmithersProcessExit(0), {
      state: "succeeded",
      terminal: true,
      needsApproval: false,
      failed: false
    });
    assert.deepEqual(classifySmithersProcessExit(3), {
      state: "paused_for_approval",
      terminal: false,
      needsApproval: true,
      failed: false
    });
    assert.deepEqual(classifySmithersProcessExit(1), {
      state: "failed",
      terminal: true,
      needsApproval: false,
      failed: true
    });
  });

  it("flags reserved output fields that collide with Smithers internals", () => {
    const findings = lintSmithersWorkflowSource(`
      const { outputs } = createSmithers({
        result: z.object({
          runId: z.string(),
          iteration: z.number().int(),
          nodeId: z.string()
        })
      });
    `);
    assert.deepEqual(findings.map((finding) => finding.kind), [
      "reserved-output-field",
      "reserved-output-field",
      "reserved-output-field"
    ]);
  });

  it("flags fractional numeric fields that should survive SQLite as strings", () => {
    const findings = lintSmithersWorkflowSource(`
      const { outputs } = createSmithers({
        scored: z.object({
          score: z.number(),
          confidence: z.number(),
          total: z.number().int()
        })
      });
    `);
    assert.deepEqual(findings.map((finding) => finding.kind), [
      "fractional-number-field",
      "fractional-number-field"
    ]);
  });

  it("flags loop bodies that read first-iteration output instead of latest output", () => {
    const findings = lintSmithersWorkflowSource(`
      export default smithers((ctx) => (
        <Workflow name="bad-loop">
          <Loop until={false}>
            <Task id="judge">{ctx.outputMaybe(outputs.critique, { nodeId: "judge" })}</Task>
          </Loop>
        </Workflow>
      ));
    `);
    assert.equal(findings[0].kind, "loop-first-output");
  });

  it("does not flag loop bodies that use latest-output semantics", () => {
    const findings = lintSmithersWorkflowSource(`
      export default smithers((ctx) => (
        <Workflow name="good-loop">
          <Loop until={Boolean(ctx.latest(outputs.critique, "judge")?.passed)}>
            <Task id="judge">{ctx.latest(outputs.critique, "judge")?.feedback}</Task>
          </Loop>
        </Workflow>
      ));
    `);
    assert.equal(findings.length, 0);
  });

  it("flags non-Anthropic agents that omit native structured output", () => {
    const findings = lintSmithersWorkflowSource(`
      const agent = new OpenAIAgent({
        model: "gpt-4.1-mini"
      });
    `);
    assert.equal(findings[0].kind, "native-structured-output");
  });

  it("flags scorer usage when scorer storage is not explicitly surfaced", () => {
    const findings = lintSmithersWorkflowSource(`
      <Task id="solve" scorers={{ judge: { scorer: solveJudge } }}>
        {"solve"}
      </Task>
    `);
    assert.equal(findings[0].kind, "scorer-storage");
  });
});
