import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCatalogHandlers } from "../src/catalogRoutes.js";
import { mockResponse as response } from "./response.js";

function req({ body = {}, params = {}, query = {} } = {}) {
  return { body, params, query };
}

function harness() {
  const upserts = [];
  const handlers = createCatalogHandlers({
    listAgents: (q) => [{ slug: "agent-1", q }],
    listKnowledge: (q) => [{ slug: "knowledge-1", q }],
    listSkills: (q) => [{ slug: "skill-1", q }],
    upsertAgent: (agent) => {
      upserts.push({ type: "agent", value: agent });
      return agent;
    },
    upsertKnowledge: (knowledge) => {
      upserts.push({ type: "knowledge", value: knowledge });
      return knowledge;
    },
    upsertSkill: (skill) => {
      upserts.push({ type: "skill", value: skill });
      return skill;
    },
    withAgentLinks: (agent) => ({ ...agent, deepLink: `/app#agents/${agent.slug}` })
  });
  return { handlers, upserts };
}

describe("catalog route helpers", () => {
  it("lists catalog resources with their existing response keys", () => {
    const { handlers } = harness();

    const agents = response();
    handlers.agents.list(req({ query: { q: "ops" } }), agents);
    assert.deepEqual(agents.body, {
      agents: [{ slug: "agent-1", q: "ops", deepLink: "/app#agents/agent-1" }]
    });

    const skills = response();
    handlers.skills.list(req({ query: { q: "review" } }), skills);
    assert.deepEqual(skills.body, { skills: [{ slug: "skill-1", q: "review" }] });

    const knowledge = response();
    handlers.knowledge.list(req(), knowledge);
    assert.deepEqual(knowledge.body, { knowledge: [{ slug: "knowledge-1", q: "" }] });
  });

  it("creates resources using the same slug fallback rules", () => {
    const { handlers, upserts } = harness();

    const agent = response();
    handlers.agents.create(req({ body: { name: "Night Agent" } }), agent);
    assert.deepEqual(agent.body, { agent: { name: "Night Agent", slug: "night-agent" } });

    const skill = response();
    handlers.skills.create(req({ body: { title: "Code Review" } }), skill);
    assert.deepEqual(skill.body, { skill: { title: "Code Review", slug: "code-review" } });

    const knowledge = response();
    handlers.knowledge.create(req({ body: { slug: "manual", title: "Manual" } }), knowledge);
    assert.deepEqual(knowledge.body, { knowledge: { slug: "manual", title: "Manual" } });
    assert.deepEqual(upserts.map((entry) => entry.type), ["agent", "skill", "knowledge"]);
  });

  it("updates resources by route slug", () => {
    const { handlers } = harness();
    const res = response();

    handlers.skills.update(req({ params: { slug: "existing" }, body: { slug: "ignored", title: "New" } }), res);

    assert.deepEqual(res.body, { skill: { slug: "existing", title: "New" } });
  });
});
