import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { seedCapabilities } from "../src/seedCatalog.js";
import { WORKFLOW_TEMPLATE_INCLUDE_PATHS } from "../src/workflowTemplateIncludes.js";
import { publishTrustedSeedWorkflowSource } from "../src/workflowBundlePublishing.js";
import { workflowBundleSha256 } from "../src/workflowBundleRecords.js";

const workflowsDir = path.join(process.cwd(), "workflow-templates", "workflows");
const includeSet = new Set(WORKFLOW_TEMPLATE_INCLUDE_PATHS);

function relativeImports(source) {
  return [...String(source || "").matchAll(/^\s*import\s+(?:[^"']+\s+from\s+)?["'](\.[^"']+)["']/gm)].map((match) => match[1]);
}

function resolveWorkflowImport(fromFile, specifier) {
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const candidates = path.extname(resolved)
    ? [resolved]
    : [".js", ".ts", ".tsx", ".jsx"].map((ext) => `${resolved}${ext}`);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function dependencyClosure(entryFile, entrySource) {
  const seen = new Set();
  const stack = [{ file: entryFile, source: entrySource }];
  const deps = [];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current.file)) continue;
    seen.add(current.file);
    for (const specifier of relativeImports(current.source)) {
      const depFile = resolveWorkflowImport(current.file, specifier);
      deps.push(depFile);
      if (seen.has(depFile) || !existsSync(depFile)) continue;
      stack.push({ file: depFile, source: readFileSync(depFile, "utf8") });
    }
  }
  return [...new Set(deps)].sort();
}

function publishProductWorkflowSeedBundle() {
  const seed = seedCapabilities.find((capability) => capability.slug === "product-workflow");
  assert.ok(seed, "product-workflow seed missing");
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
  assert.equal(published.definition.workflow.bundleId, "wfb_product-workflow");
  return bundles[0];
}

describe("product-workflow published bundle dependency closure", () => {
  it("ships every relative dependency the DB bundle needs at runner materialization time", () => {
    const bundle = publishProductWorkflowSeedBundle();
    const entryFile = path.join(workflowsDir, "product-workflow.tsx");
    const deps = dependencyClosure(entryFile, bundle.code);

    assert.deepEqual(
      deps.map((file) => path.relative(workflowsDir, file)),
      ["agent-fallback.js", "improve-repo.js", "pi-harness.js"]
    );

    for (const file of [entryFile, ...deps]) {
      assert.ok(existsSync(file), `${path.relative(process.cwd(), file)} missing`);
      const includePath = path.relative(process.cwd(), file);
      assert.equal(
        includeSet.has(includePath),
        true,
        `${includePath} must be copied into runner workspaces so DB bundles can resolve relative imports`
      );
    }
  });
});
