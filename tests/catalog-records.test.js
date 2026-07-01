import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentInsertQuery,
  agentListQuery,
  agentLookupQuery,
  agentPayload,
  agentUpdateQuery,
  knowledgeInsertQuery,
  knowledgeListQuery,
  knowledgeLookupQuery,
  knowledgePayload,
  knowledgeUpdateQuery,
  normalizeEditable,
  normalizeKnowledge,
  normalizeToken,
  skillInsertQuery,
  skillListQuery,
  skillLookupQuery,
  skillPayload,
  skillUpdateQuery
} from "../src/catalogRecords.js";

describe("catalog record helpers", () => {
  it("normalizes access tokens with expiry and revocation state", () => {
    const activeRow = {
      id: "tok_1",
      name: "API",
      scopes: '["api","admin"]',
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
      expires_at: "2026-02-01T00:00:00.000Z"
    };
    const active = normalizeToken(activeRow, { nowIso: "2026-01-15T00:00:00.000Z" });
    assert.deepEqual(active.scopes, ["api", "admin"]);
    assert.equal(active.active, true);

    const expired = normalizeToken({ ...activeRow, scopes: "[]", expires_at: "2026-01-01T00:00:00.000Z" }, {
      nowIso: "2026-01-15T00:00:00.000Z"
    });
    assert.equal(expired.active, false);

    const revoked = normalizeToken({ ...activeRow, scopes: "[]", revoked_at: "2026-01-10T00:00:00.000Z" }, {
      nowIso: "2026-01-15T00:00:00.000Z"
    });
    assert.equal(revoked.active, false);
  });

  it("normalizes editable agent and skill rows with optional fields", () => {
    const editable = normalizeEditable({
      id: "agent_1",
      slug: "builder",
      name: "Builder",
      description: "Builds",
      instructions: "Ship",
      tools: '["shell"]',
      skill_slugs: '["review"]',
      tags: '["code"]',
      enabled: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      version: 2
    }, ["id", "slug", "name", "description", "instructions"]);

    assert.equal(editable.slug, "builder");
    assert.deepEqual(editable.tools, ["shell"]);
    assert.deepEqual(editable.skillSlugs, ["review"]);
    assert.deepEqual(editable.tags, ["code"]);
    assert.equal(editable.enabled, true);
    assert.equal(editable.version, 2);
  });

  it("builds agent, skill, and knowledge payloads with stable defaults", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";

    assert.deepEqual(agentPayload({
      slug: "agent",
      name: "Agent",
      skillSlugs: ["skill"],
      enabled: false
    }, timestamp), {
      slug: "agent",
      name: "Agent",
      description: "",
      instructions: "",
      tools: "[]",
      skill_slugs: '["skill"]',
      tags: "[]",
      enabled: 0,
      updated_at: timestamp
    });

    assert.deepEqual(skillPayload({ slug: "skill", name: "Skill", tags: ["one"] }, timestamp), {
      slug: "skill",
      name: "Skill",
      description: "",
      body: "",
      tags: '["one"]',
      enabled: 1,
      updated_at: timestamp
    });

    assert.deepEqual(knowledgePayload({ slug: "doc", title: "Doc" }, timestamp), {
      slug: "doc",
      title: "Doc",
      type: "doc",
      body: "",
      url: "",
      tags: "[]",
      updated_at: timestamp
    });
  });

  it("normalizes knowledge rows", () => {
    const knowledge = normalizeKnowledge({
      id: "know_1",
      slug: "handbook",
      title: "Handbook",
      type: "doc",
      body: "Read me",
      url: "https://example.test",
      tags: '["ops"]',
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z"
    });

    assert.equal(knowledge.slug, "handbook");
    assert.deepEqual(knowledge.tags, ["ops"]);
    assert.equal(knowledge.createdAt, "2026-01-01T00:00:00.000Z");
  });

  it("builds catalog list and search queries consistently", () => {
    assert.deepEqual(agentListQuery(), {
      sql: "SELECT * FROM agents ORDER BY name",
      params: []
    });
    assert.deepEqual(agentListQuery("build"), {
      sql: "SELECT * FROM agents WHERE name LIKE ? OR slug LIKE ? OR description LIKE ? ORDER BY name",
      params: ["%build%", "%build%", "%build%"]
    });
    assert.deepEqual(skillListQuery("review"), {
      sql: "SELECT * FROM skills WHERE name LIKE ? OR slug LIKE ? OR description LIKE ? OR body LIKE ? ORDER BY name",
      params: ["%review%", "%review%", "%review%", "%review%"]
    });
    assert.deepEqual(knowledgeListQuery("ops"), {
      sql: "SELECT * FROM knowledge_resources WHERE title LIKE ? OR slug LIKE ? OR body LIKE ? OR tags LIKE ? ORDER BY title",
      params: ["%ops%", "%ops%", "%ops%", "%ops%"]
    });
  });

  it("builds catalog lookup and write queries", () => {
    assert.deepEqual(agentLookupQuery("builder"), {
      sql: "SELECT * FROM agents WHERE slug = ?",
      params: ["builder"]
    });
    assert.deepEqual(agentUpdateQuery(), {
      sql: `UPDATE agents SET name=$name, description=$description, instructions=$instructions, tools=$tools,
       skill_slugs=$skill_slugs, tags=$tags, enabled=$enabled, version=version+1, updated_at=$updated_at WHERE slug=$slug`
    });
    assert.deepEqual(agentInsertQuery(), {
      sql: `INSERT INTO agents (id, slug, name, description, instructions, tools, skill_slugs, tags, enabled, created_at, updated_at)
       VALUES ($id, $slug, $name, $description, $instructions, $tools, $skill_slugs, $tags, $enabled, $created_at, $updated_at)`
    });

    assert.deepEqual(skillLookupQuery("review"), {
      sql: "SELECT * FROM skills WHERE slug = ?",
      params: ["review"]
    });
    assert.deepEqual(skillUpdateQuery(), {
      sql: "UPDATE skills SET name=$name, description=$description, body=$body, tags=$tags, enabled=$enabled, version=version+1, updated_at=$updated_at WHERE slug=$slug"
    });
    assert.deepEqual(skillInsertQuery(), {
      sql: "INSERT INTO skills (id, slug, name, description, body, tags, enabled, created_at, updated_at) VALUES ($id, $slug, $name, $description, $body, $tags, $enabled, $created_at, $updated_at)"
    });

    assert.deepEqual(knowledgeLookupQuery("handbook"), {
      sql: "SELECT * FROM knowledge_resources WHERE slug = ?",
      params: ["handbook"]
    });
    assert.deepEqual(knowledgeUpdateQuery(), {
      sql: "UPDATE knowledge_resources SET title=$title, type=$type, body=$body, url=$url, tags=$tags, updated_at=$updated_at WHERE slug=$slug"
    });
    assert.deepEqual(knowledgeInsertQuery(), {
      sql: "INSERT INTO knowledge_resources (id, slug, title, type, body, url, tags, created_at, updated_at) VALUES ($id, $slug, $title, $type, $body, $url, $tags, $created_at, $updated_at)"
    });
  });
});
