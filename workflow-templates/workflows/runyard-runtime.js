import { readFileSync } from "node:fs";

let cachedPack = null;

function loadRuntimePack() {
  if (cachedPack) return cachedPack;
  const file = process.env.RUNYARD_AGENT_RUNTIME_PACK_FILE || "";
  const inline = process.env.RUNYARD_AGENT_RUNTIME_PACK_JSON || "";
  if (!file && !inline) {
    cachedPack = { schemaVersion: 1, agents: [], skills: [], missing: { agents: [], skills: [] } };
    return cachedPack;
  }
  const raw = file ? readFileSync(file, "utf8") : inline;
  try {
    cachedPack = JSON.parse(raw);
  } catch {
    cachedPack = { schemaVersion: 1, agents: [], skills: [], missing: { agents: [], skills: [] } };
  }
  return cachedPack;
}

export function runyardRuntimePack() {
  return loadRuntimePack();
}

export function runyardAgent(slug) {
  const pack = loadRuntimePack();
  return (pack.agents || []).find((agent) => agent.slug === slug) || null;
}

export function runyardSkill(slug) {
  const pack = loadRuntimePack();
  return (pack.skills || []).find((skill) => skill.slug === slug) || null;
}

export function runyardAgentSystemPrompt(slug, fallback = "", options = {}) {
  const agent = runyardAgent(slug);
  const pack = loadRuntimePack();
  const skillSlugs = new Set([...(options.skillSlugs || []), ...((agent && agent.skillSlugs) || [])]);
  const skills = [...skillSlugs].map((skillSlug) => runyardSkill(skillSlug)).filter(Boolean);
  const sections = [];
  if (fallback) sections.push(fallback);
  if (agent?.instructions) {
    sections.push(
      [
        `RunYard runtime agent: ${agent.name || agent.slug}`,
        `Agent slug: ${agent.slug}`,
        `Agent version: ${agent.version || "unknown"}`,
        agent.instructions
      ].join("\n")
    );
  }
  if (skills.length) {
    sections.push(
      [
        "RunYard runtime skills:",
        ...skills.map((skill) =>
          [`Skill: ${skill.name || skill.slug}`, `Slug: ${skill.slug}`, `Version: ${skill.version || "unknown"}`, skill.body || ""].join("\n")
        )
      ].join("\n\n")
    );
  }
  if (pack.missing?.agents?.length || pack.missing?.skills?.length) {
    sections.push(`RunYard runtime pack missing definitions: ${JSON.stringify(pack.missing)}`);
  }
  return sections.filter(Boolean).join("\n\n");
}
