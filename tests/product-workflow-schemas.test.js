import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const source = readFileSync(path.join(process.cwd(), "workflow-templates", "workflows", "product-workflow.tsx"), "utf8");

function createSmithersOutputs() {
  const match = source.match(/createSmithers\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(match, "product-workflow must register outputs with createSmithers");
  return [...match[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g)]
    .map((entry) => ({ output: entry[1], schema: entry[2] }))
    .filter((entry) => entry.output !== "input");
}

describe("product-workflow Codex structured output schemas", () => {
  it("uses strict Zod objects for every Codex-reachable typed output and nested row", () => {
    for (const name of [
      "competitor",
      "mappedFeature",
      "prioritizedFeature",
      "childPayload",
      "dispatchedRun"
    ]) {
      assert.match(source, new RegExp(`const ${name}Schema = z\\.object\\(`), `${name}Schema must be strict`);
    }
    for (const name of ["baselineOut", "researchOut", "featureMapOut", "prioritizeOut", "dispatchOut"]) {
      assert.match(source, new RegExp(`const ${name} = z\\.object\\(`), `${name} must be strict`);
    }
    assert.doesNotMatch(source, /z\.looseObject/);
    assert.doesNotMatch(source, /\.passthrough\s*\(/);
    assert.doesNotMatch(source, /\.catchall\s*\(/);
  });

  it("registers only strict object schemas as Smithers structured outputs", () => {
    const strictObjectBindings = new Set(
      [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*z\.object\s*\(/g)].map((match) => match[1])
    );
    const outputs = createSmithersOutputs();
    assert.deepEqual(outputs.map((entry) => entry.output), [
      "baseline",
      "research",
      "researchReady",
      "featureMap",
      "featureMapReady",
      "prioritize",
      "prioritizeReady",
      "dispatch"
    ]);
    for (const { output, schema } of outputs) {
      assert.equal(strictObjectBindings.has(schema), true, `${output} output must use a strict z.object schema binding`);
    }
  });

  it("keeps dispatch payload finite instead of an open object", () => {
    assert.match(source, /payload: childPayloadSchema\.default\(\{\}\)/);
    for (const field of ["workPrompt", "targetBranch", "commitMessage", "repoDir", "project", "repo"]) {
      assert.match(source, new RegExp(`${field}: z\\.string\\(\\)`));
    }
    assert.match(source, /mutationMode: z\.enum\(\["parallel"\]\)\.default\("parallel"\)/);
    assert.match(source, /agentHarness: z\.enum\(\["claude", "codex", "pi"\]\)\.default\("codex"\)/);
    assert.match(source, /mutationMode:\s*"parallel"/);
  });

  it("does not blanket-disable useful retries on agent stages", () => {
    for (const task of ["research", "featureMap", "prioritize"]) {
      assert.doesNotMatch(
        source,
        new RegExp(`<Task id="${task}"[^>]*agent=\\{[^}]+\\}[^>]*retries=\\{0\\}`),
        `${task} agent task should keep Smithers retries available for transient failures`
      );
    }
  });

  it('routes every agent-backed stage through the PRODUCT harness selection, so agentHarness:"codex" stays primary', () => {
    const productHarnessResolution = [
      ...source.matchAll(/primaryCli:\s*resolveAgentCli\(process\.env,\s*\{\s*workflow:\s*"PRODUCT",\s*fallback:\s*"claude"\s*\}\)/g)
    ];
    assert.equal(productHarnessResolution.length, 2, "researcher and strategist must both use PRODUCT harness resolution");
    assert.match(source, /const researcher = createResearcher\(repoDir\)/);
    assert.match(source, /const strategist = createStrategist\(repoDir\)/);
    assert.match(source, /<Task id="research"[^>]*agent=\{researcher\}/);
    assert.match(source, /<Task id="featureMap"[^>]*agent=\{strategist\}/);
    assert.match(source, /<Task id="prioritize"[^>]*agent=\{strategist\}/);
  });
});
