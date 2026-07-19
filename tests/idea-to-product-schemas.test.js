import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { z } from "zod/v4";

import {
  codexStructuredOutputSchemas,
  copySchema,
  hooksSchema,
  specSchema
} from "../workflow-templates/workflows/idea-to-product-schemas.js";
import { WORKFLOW_TEMPLATE_INCLUDE_PATHS } from "../src/workflowTemplateIncludes.js";

function assertStrictObjects(node, trail = "$") {
  if (!node || typeof node !== "object") return;
  if (node.type === "object") {
    assert.equal(node.additionalProperties, false, `${trail} must set additionalProperties:false`);
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertStrictObjects(item, `${trail}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    assertStrictObjects(value, `${trail}.${key}`);
  }
}

describe("idea-to-product Codex structured output schemas", () => {
  it("uses strict Zod objects for every Codex-reachable typed output, recursively", () => {
    for (const [name, schema] of Object.entries(codexStructuredOutputSchemas)) {
      const jsonSchema = z.toJSONSchema(schema);
      assertStrictObjects(jsonSchema, name);
      assert.doesNotMatch(JSON.stringify(jsonSchema), /"additionalProperties":\{\}/, name);
    }
  });

  it("preserves intended defaults and required-field validation", () => {
    assert.equal(specSchema.parse({
      appName: "Demo",
      subdomain: "demo",
      productDir: "/tmp/demo",
      oneLiner: "Demo app"
    }).locale, "en-US");
    assert.deepEqual(copySchema.parse({ passed: true }).findings, []);
    assert.deepEqual(hooksSchema.parse({ status: "skipped" }).results, []);
    assert.throws(() => codexStructuredOutputSchemas.expand.parse({}), /opportunity/);
  });

  it("ships the schema helper with the tracked workflow template", () => {
    const source = readFileSync(path.join(process.cwd(), "workflow-templates", "workflows", "idea-to-product.tsx"), "utf8");
    assert.match(source, /idea-to-product-schemas\.js/);
    assert.doesNotMatch(source, /z\.looseObject/);
    assert.ok(WORKFLOW_TEMPLATE_INCLUDE_PATHS.includes("workflow-templates/workflows/idea-to-product-schemas.js"));
  });
});
