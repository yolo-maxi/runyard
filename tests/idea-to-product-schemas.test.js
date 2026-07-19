import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const source = readFileSync(path.join(process.cwd(), "workflow-templates", "workflows", "idea-to-product.tsx"), "utf8");

describe("idea-to-product Codex structured output schemas", () => {
  it("uses strict Zod objects for every Codex-reachable typed output, including nested hook results", () => {
    for (const name of ["expansion", "spec", "guard", "build", "copy", "verify", "hookResult", "hooks"]) {
      assert.match(source, new RegExp(`const ${name}Schema = z\\.object\\(`), `${name}Schema must be strict`);
    }
    assert.doesNotMatch(source, /z\.looseObject/);
    assert.match(source, /results: z\.array\(hookResultSchema\)\.default\(\[\]\)/);
  });

  it("keeps strict schemas inside the single workflow bundle", () => {
    assert.match(source, /import \{ z \} from "zod\/v4"/);
    assert.doesNotMatch(source, /idea-to-product-schemas\.js/);
  });
});
