import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addAgentSkillSlugs,
  buildRuntimePack,
  requiredAgentSlugs,
  requiredSkillSlugs,
  runtimePackPayload
} from "../src/runtimePackRecords.js";

describe("runtime pack record helpers", () => {
  it("collects deduped required agent and skill slugs", () => {
    const capability = {
      requiredAgents: [" product-manager ", "", "builder", "product-manager"],
      requiredSkills: [" review ", null, "implementation", "review"]
    };

    assert.deepEqual(requiredAgentSlugs(capability), ["product-manager", "builder"]);
    assert.deepEqual([...requiredSkillSlugs(capability)], ["review", "implementation"]);
  });

  it("adds skill slugs declared by resolved agents", () => {
    const skills = addAgentSkillSlugs(new Set(["base"]), {
      skillSlugs: [" product-review ", "", "base"]
    });

    assert.deepEqual([...skills], ["base", "product-review"]);
  });

  it("builds runtime pack payloads with missing references", () => {
    assert.deepEqual(runtimePackPayload({
      capability: {
        slug: "improve",
        name: "Improve",
        version: 4
      },
      requiredAgents: ["pm"],
      requiredSkills: new Set(["review"]),
      agents: [{ slug: "pm", version: 2 }],
      skills: [{ slug: "review", version: 3 }],
      missingAgents: ["missing-agent"],
      missingSkills: ["missing-skill"],
      capturedAt: "2026-01-01T00:00:00.000Z"
    }), {
      schemaVersion: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
      capability: {
        slug: "improve",
        name: "Improve",
        version: 4,
        requiredAgents: ["pm"],
        requiredSkills: ["review"]
      },
      agents: [{ slug: "pm", version: 2 }],
      skills: [{ slug: "review", version: 3 }],
      missing: {
        agents: ["missing-agent"],
        skills: ["missing-skill"]
      }
    });

    assert.equal(runtimePackPayload({ capturedAt: "now" }).capability, null);
  });

  it("resolves agents, transitive skills, and missing references", () => {
    const agents = new Map([
      ["pm", { slug: "pm", skillSlugs: ["review", "planning"] }]
    ]);
    const skills = new Map([
      ["review", { slug: "review" }],
      ["planning", { slug: "planning" }]
    ]);

    assert.deepEqual(buildRuntimePack({
      capability: {
        slug: "improve",
        name: "Improve",
        version: 1,
        requiredAgents: ["pm", "missing-agent"],
        requiredSkills: ["review", "missing-skill"]
      },
      getAgent: (slug) => agents.get(slug),
      getSkill: (slug) => skills.get(slug),
      capturedAt: "2026-01-01T00:00:00.000Z"
    }), {
      schemaVersion: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
      capability: {
        slug: "improve",
        name: "Improve",
        version: 1,
        requiredAgents: ["pm", "missing-agent"],
        requiredSkills: ["review", "missing-skill", "planning"]
      },
      agents: [{ slug: "pm", skillSlugs: ["review", "planning"] }],
      skills: [{ slug: "review" }, { slug: "planning" }],
      missing: {
        agents: ["missing-agent"],
        skills: ["missing-skill"]
      }
    });
  });
});
