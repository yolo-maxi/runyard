import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { developmentFactoryDefinition } from "../src/boardDefinition.js";
import { seedCapabilities } from "../src/seedCatalog.js";
import { publishTrustedSeedWorkflowSource } from "../src/workflowBundlePublishing.js";
import { workflowBundleSha256 } from "../src/workflowBundleRecords.js";

const factoryWorkflowSlugs = developmentFactoryDefinition().defaultWorkflows;

function workflowFileForSlug(slug) {
  const seed = seedCapabilities.find((capability) => capability.slug === slug);
  assert.ok(seed, `factory workflow ${slug} must be seeded`);
  return path.basename(seed.workflow.entry);
}

function publishSeedBundle(slug) {
  const seed = seedCapabilities.find((capability) => capability.slug === slug);
  const bundles = [];
  const published = publishTrustedSeedWorkflowSource({
    definition: seed,
    root: process.cwd(),
    listWorkflowBundles: ({ capabilitySlug }) => bundles.filter((bundle) => bundle.capabilitySlug === capabilitySlug),
    publishWorkflowBundle: ({ capabilitySlug, code, language, createdBy }) => {
      const bundle = {
        id: `wfb_${capabilitySlug}`,
        capabilitySlug,
        version: 1,
        language,
        code,
        sha256: workflowBundleSha256(code),
        createdBy
      };
      bundles.push(bundle);
      return bundle;
    },
    createdBy: "test-seed"
  });
  assert.equal(published.definition.workflow.bundleId, `wfb_${slug}`);
  return bundles[0];
}

describe("factory default workflow schemas", () => {
  it('pins daily RunYard roadmap shaping to Codex while keeping execute:false', () => {
    const schedule = developmentFactoryDefinition().schedules.find(
      (entry) => entry.slug === "runyard-daily-roadmap-shaping"
    );
    assert.ok(schedule, "factory must seed the daily roadmap shaping schedule");
    assert.equal(schedule.workflow, "product-workflow");
    assert.equal(schedule.input.agentHarness, "codex");
    assert.equal(schedule.input.execute, false);
    assert.equal(schedule.enabled, false);
  });

  it("do not use loose output objects in workflows launched from the factory board", () => {
    for (const slug of factoryWorkflowSlugs) {
      const file = workflowFileForSlug(slug);
      const source = readFileSync(path.join(process.cwd(), "workflow-templates", "workflows", file), "utf8");
      const outputSection = source.slice(0, source.indexOf("const inputSchema"));
      assert.doesNotMatch(outputSection, /z\.looseObject/, `${file} must not emit open structured-output object schemas`);
    }
  });

  it("publishes factory seed bundles from strict workflow source, not patched DB rows", () => {
    for (const slug of factoryWorkflowSlugs) {
      const bundle = publishSeedBundle(slug);
      assert.ok(bundle?.code, `${slug} seed must publish workflow source`);
      const inputAt = bundle.code.indexOf("const inputSchema");
      const outputSection = inputAt >= 0 ? bundle.code.slice(0, inputAt) : bundle.code;
      assert.doesNotMatch(outputSection, /z\.looseObject/, `${slug} published bundle must not contain loose output schemas`);
    }
  });

  it("keeps docs-update trigger metadata as input-only open objects", () => {
    const source = readFileSync(path.join(process.cwd(), "workflow-templates", "workflows", "docs-update.tsx"), "utf8");
    assert.match(source, /adapter: z\s*\n\s*\.looseObject\(/);
    assert.match(source, /payload: z\.looseObject\(\{\}\)\.optional\(\)/);
  });
});
