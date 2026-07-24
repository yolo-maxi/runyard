import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { seedCapabilities } from "../src/seedCatalog.js";
import { publishTrustedSeedWorkflowSource } from "../src/workflowBundlePublishing.js";
import { workflowBundleSha256 } from "../src/workflowBundleRecords.js";

const scoutSourcePath = path.join(process.cwd(), "workflow-templates", "workflows", "product-scout.tsx");

function scoutSeed() {
  const seed = seedCapabilities.find((capability) => capability.slug === "product-scout");
  assert.ok(seed, "product-scout workflow must be seeded");
  return seed;
}

describe("product-scout workflow", () => {
  it("is seeded as a read-only proposal workflow", () => {
    const seed = scoutSeed();
    assert.equal(seed.workflow.entry, ".smithers/workflows/product-scout.tsx");
    assert.equal(seed.approvalPolicy.required, false);
    assert.deepEqual(seed.requiredRunnerTags, ["smithers"]);
    assert.equal(seed.inputSchema.required.includes("objective"), true);
    assert.equal(seed.inputSchema.properties.repo.description.includes("friendly repo key"), true);
    assert.match(seed.description, /never edits code/i);
  });

  it("uses strict structured output schemas and private-data guardrails", () => {
    const source = readFileSync(scoutSourcePath, "utf8");
    const outputSection = source.slice(0, source.indexOf("const inputSchema"));
    assert.doesNotMatch(outputSection, /z\.looseObject/, "product-scout must not use loose output schemas");
    assert.match(source, /Do not read secrets, token files, raw SQLite databases, raw Gmail exports/i);
    assert.match(source, /human-private-data/);
    assert.match(source, /suggestedRunInputJson/);
  });

  it("publishes the seeded workflow source as a bundle", () => {
    const bundles = [];
    const result = publishTrustedSeedWorkflowSource({
      definition: scoutSeed(),
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
    assert.equal(result.definition.workflow.bundleId, "wfb_product-scout");
    assert.match(bundles[0].code, /Product Scout/);
  });
});
