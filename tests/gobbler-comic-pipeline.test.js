import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { seedCapabilities } from "../src/seeds.js";
import { WORKFLOW_TEMPLATE_INCLUDE_PATHS } from "../src/workflowTemplateIncludes.js";

describe("gobbler comic pipeline", () => {
  it("is not part of the release-candidate workflow catalog", () => {
    const cap = seedCapabilities.find((entry) => entry.slug === "gobbler-comic-pipeline");
    assert.equal(cap, undefined);
    assert.equal(WORKFLOW_TEMPLATE_INCLUDE_PATHS.includes("workflow-templates/workflows/gobbler-comic-pipeline.tsx"), false);
  });
});
