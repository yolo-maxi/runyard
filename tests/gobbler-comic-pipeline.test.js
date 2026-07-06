import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { seedCapabilities } from "../src/seeds.js";

describe("gobbler comic pipeline", () => {
  it("seeds the Gobbler comic marketing capability", () => {
    const cap = seedCapabilities.find((entry) => entry.slug === "gobbler-comic-pipeline");
    assert.ok(cap, "gobbler-comic-pipeline should be seeded");
    assert.equal(cap.category, "Marketing");
    assert.deepEqual(cap.requiredRunnerTags, ["smithers", "vps"]);
    assert.equal(cap.approvalPolicy.required, true);
    assert.equal(cap.supervision?.default, undefined);
    assert.equal(cap.workflow.entry, ".smithers/workflows/gobbler-comic-pipeline.tsx");
    assert.equal(cap.inputSchema.required.includes("signal"), true);
  });

  it("ships a constrained workflow with copy punch-up before Codex image_gen prompts", () => {
    const file = path.join(process.cwd(), "workflow-templates", "workflows", "gobbler-comic-pipeline.tsx");
    assert.ok(existsSync(file));
    const src = readFileSync(file, "utf8");

    const copyIndex = src.indexOf('Task id="copy:funniness-pass"');
    const imageIndex = src.indexOf('Task id="image:prompt-pack"');
    assert.ok(copyIndex > 0, "workflow should include a copy/funniness pass");
    assert.ok(imageIndex > copyIndex, "image prompt pack must run after the copy/funniness pass");

    assert.match(src, /Codex image_gen/);
    assert.match(src, /Do not call or recommend Midjourney, DALL-E, Ideogram, Leonardo, Stable Diffusion/);
    assert.match(src, /Do not generate images in this text step/);
    assert.match(src, /Do not generate images and do not post publicly/);
    assert.match(src, /GLOOM & GOBBLE STYLE BIBLE/);
    assert.match(src, /The disappearance is the setting, not the punchline/);
  });
});
