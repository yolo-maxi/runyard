import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedCapabilities } from "../src/seeds.js";
import { WORKFLOW_TEMPLATE_INCLUDE_PATHS } from "../src/workflowTemplateIncludes.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Retired product-candidate workflows must never come back as seeds, bundled
// templates, or checked-in template files.
const RETIRED_PRODUCT_CANDIDATES = [
  "gobbler-comic-pipeline",
  "app-skinner",
  "national-spirit-question-factory"
];

describe("retired release-candidate workflows", () => {
  for (const slug of RETIRED_PRODUCT_CANDIDATES) {
    it(`${slug} is not seeded, bundled, or checked in`, () => {
      const cap = seedCapabilities.find((entry) => entry.slug === slug);
      assert.equal(cap, undefined);
      const templatePath = `workflow-templates/workflows/${slug}.tsx`;
      assert.equal(WORKFLOW_TEMPLATE_INCLUDE_PATHS.includes(templatePath), false);
      assert.equal(existsSync(path.join(repoRoot, templatePath)), false);
    });
  }
});
