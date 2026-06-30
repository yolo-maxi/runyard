import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { seedCapabilities } from "../src/seeds.js";

describe("golden smoke workflow", () => {
  it("seeds a cheap RunYard smoke-check capability", () => {
    const cap = seedCapabilities.find((entry) => entry.slug === "runyard-smoke-check");
    assert.ok(cap, "runyard-smoke-check should be seeded");
    assert.equal(cap.category, "Operations");
    assert.deepEqual(cap.requiredRunnerTags, ["smithers"]);
    assert.equal(cap.supervision.default, false);
    assert.equal(cap.workflow.entry, ".smithers/workflows/runyard-smoke-check.tsx");
  });

  it("ships the smoke workflow template without model agents", () => {
    const file = path.join(process.cwd(), "workflow-templates", "workflows", "runyard-smoke-check.tsx");
    assert.ok(existsSync(file));
    const src = readFileSync(file, "utf8");
    assert.match(src, /RunYard smoke check/);
    assert.doesNotMatch(src, /ClaudeCodeAgent|CodexAgent|providers\.claude|providers\.codex/);
    assert.match(src, /workflow-rendered/);
    assert.match(src, /hub-url-configured/);
  });
});
