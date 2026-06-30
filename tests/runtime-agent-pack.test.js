import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-runtime-pack-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_runtime_pack_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { buildAgentRuntimePack, getCapability, upsertAgent, upsertSkill } = await import("../src/db.js");

describe("runtime agent/skill pack", () => {
  it("captures current UI-editable agent and skill versions for a capability", () => {
    upsertSkill({
      slug: "product-review",
      name: "Product Review Rubric",
      description: "test override",
      body: "Runtime skill body from the UI."
    });
    upsertAgent({
      slug: "product-manager",
      name: "Product Manager (with taste)",
      description: "test override",
      instructions: "Runtime product manager instructions from the UI.",
      skillSlugs: ["product-review"]
    });

    const pack = buildAgentRuntimePack(getCapability("improve"));
    const pm = pack.agents.find((agent) => agent.slug === "product-manager");
    const skill = pack.skills.find((entry) => entry.slug === "product-review");

    assert.ok(pm, "product-manager should be captured");
    assert.equal(pm.instructions, "Runtime product manager instructions from the UI.");
    assert.ok(pm.version >= 2, "edited agent version should be snapshotted");
    assert.ok(skill, "linked product-review skill should be captured");
    assert.equal(skill.body, "Runtime skill body from the UI.");
    assert.ok(skill.version >= 2, "edited skill version should be snapshotted");
  });

  it("composes workflow system prompts from the runtime pack", async () => {
    const packFile = path.join(temp, "runtime-pack.json");
    writeFileSync(
      packFile,
      JSON.stringify({
        schemaVersion: 1,
        agents: [
          {
            slug: "product-manager",
            name: "Product Manager",
            instructions: "Use the edited agent instruction.",
            skillSlugs: ["product-review"],
            version: 7
          }
        ],
        skills: [
          {
            slug: "product-review",
            name: "Product Review",
            body: "Use the edited skill body.",
            version: 9
          }
        ],
        missing: { agents: [], skills: [] }
      })
    );
    process.env.RUNYARD_AGENT_RUNTIME_PACK_FILE = packFile;
    const helperUrl = pathToFileURL(path.join(process.cwd(), "workflow-templates", "workflows", "runyard-runtime.js"));
    helperUrl.search = `runtimePackTest=${Date.now()}`;
    const { runyardAgentSystemPrompt } = await import(helperUrl.href);

    const prompt = runyardAgentSystemPrompt("product-manager", "Hard safety fallback.", { skillSlugs: ["product-review"] });
    assert.match(prompt, /Hard safety fallback/);
    assert.match(prompt, /Use the edited agent instruction/);
    assert.match(prompt, /Use the edited skill body/);
    assert.match(prompt, /Agent version: 7/);
    assert.match(prompt, /Version: 9/);
  });
});
