import { requireBodySlug } from "./requestContext.js";

function createResourceHandlers({ list, upsert, responseKey, slugFallback, decorate = (item) => item }) {
  return {
    list(req, res) {
      res.json({ [responseKey]: list(req.query.q || "").map(decorate) });
    },

    create(req, res) {
      res.json({
        [slugFallback]: upsert({
          ...req.body,
          slug: requireBodySlug(req.body, slugFallback)
        })
      });
    },

    update(req, res) {
      res.json({
        [slugFallback]: upsert({
          ...req.body,
          slug: req.params.slug
        })
      });
    }
  };
}

export function createCatalogHandlers({
  listAgents,
  listKnowledge,
  listSkills,
  upsertAgent,
  upsertKnowledge,
  upsertSkill,
  withAgentLinks
} = {}) {
  return {
    agents: createResourceHandlers({
      list: listAgents,
      upsert: upsertAgent,
      responseKey: "agents",
      slugFallback: "agent",
      decorate: withAgentLinks
    }),
    skills: createResourceHandlers({
      list: listSkills,
      upsert: upsertSkill,
      responseKey: "skills",
      slugFallback: "skill"
    }),
    knowledge: createResourceHandlers({
      list: listKnowledge,
      upsert: upsertKnowledge,
      responseKey: "knowledge",
      slugFallback: "knowledge"
    })
  };
}
