function cleanSlug(slug) {
  return String(slug || "").trim();
}

export function requiredAgentSlugs(capability) {
  return [...new Set((capability?.requiredAgents || []).map(cleanSlug).filter(Boolean))];
}

export function requiredSkillSlugs(capability) {
  return new Set((capability?.requiredSkills || []).map(cleanSlug).filter(Boolean));
}

export function addAgentSkillSlugs(skillSlugs, agent) {
  const next = new Set(skillSlugs || []);
  for (const slug of agent?.skillSlugs || []) {
    const clean = cleanSlug(slug);
    if (clean) next.add(clean);
  }
  return next;
}

export function runtimePackPayload({
  capability,
  requiredAgents = [],
  requiredSkills = [],
  agents = [],
  skills = [],
  missingAgents = [],
  missingSkills = [],
  capturedAt
}) {
  return {
    schemaVersion: 1,
    capturedAt,
    capability: capability
      ? {
          slug: capability.slug,
          name: capability.name,
          version: capability.version,
          requiredAgents,
          requiredSkills: [...requiredSkills]
        }
      : null,
    agents,
    skills,
    missing: { agents: missingAgents, skills: missingSkills }
  };
}

export function buildRuntimePack({
  capability,
  getAgent,
  getSkill,
  capturedAt
}) {
  const requiredAgents = requiredAgentSlugs(capability);
  let requiredSkills = requiredSkillSlugs(capability);
  const agents = [];
  const missingAgents = [];
  for (const slug of requiredAgents) {
    const agent = getAgent(slug);
    if (!agent) {
      missingAgents.push(slug);
      continue;
    }
    agents.push(agent);
    requiredSkills = addAgentSkillSlugs(requiredSkills, agent);
  }

  const skills = [];
  const missingSkills = [];
  for (const slug of [...requiredSkills]) {
    const skill = getSkill(slug);
    if (!skill) {
      missingSkills.push(slug);
      continue;
    }
    skills.push(skill);
  }

  return runtimePackPayload({
    capability,
    requiredAgents,
    requiredSkills,
    agents,
    skills,
    missingAgents,
    missingSkills,
    capturedAt
  });
}
