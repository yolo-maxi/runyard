import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capabilityDefinitionHash,
  capabilityDefinitionHashUpdateQuery,
  capabilityIdQuery,
  capabilityInsertQuery,
  capabilityListQuery,
  capabilityLookupQuery,
  capabilityPayloadFromDefinition,
  capabilitySlugQuery,
  capabilityUpdateQuery,
  capabilityVersionInsertQuery,
  normalizeCapability,
  normalizeCapabilityDefinition
} from "../src/capabilityRecords.js";

describe("capability record helpers", () => {
  it("normalizes database rows into API-facing capability records", () => {
    const capability = normalizeCapability({
      id: "cap_1",
      slug: "ship-it",
      name: "Ship it",
      description: "Deploys",
      category: "Delivery",
      keywords: '["deploy","release"]',
      input_schema: '{"type":"object"}',
      output_schema: '{"type":"object","properties":{"url":{"type":"string"}}}',
      required_runner_tags: '["builder"]',
      required_skills: '["deploy"]',
      required_agents: '["engineer"]',
      approval_policy: '{"mode":"required"}',
      supervision: '{"enabled":true}',
      workflow: '{"steps":[]}',
      max_run_minutes: 45,
      definition_hash: "abc123",
      version: 3,
      enabled: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z"
    });

    assert.deepEqual(capability.keywords, ["deploy", "release"]);
    assert.deepEqual(capability.inputSchema, { type: "object" });
    assert.deepEqual(capability.requiredRunnerTags, ["builder"]);
    assert.equal(capability.maxRunMinutes, 45);
    assert.equal(capability.enabled, true);
    assert.equal(capability.definitionHash, "abc123");
  });

  it("builds stable definitions and database payloads from mixed input shapes", () => {
    const definition = normalizeCapabilityDefinition({
      slug: "build",
      name: "Build",
      keywords: '["code"]',
      input_schema: '{"type":"object"}',
      requiredRunnerTags: ["runner"],
      supervision_policy: '{"default":true}',
      max_run_minutes: "30",
      enabled: 0
    });

    assert.deepEqual(definition, {
      slug: "build",
      name: "Build",
      description: "",
      category: "General",
      keywords: ["code"],
      inputSchema: { type: "object" },
      outputSchema: {},
      requiredRunnerTags: ["runner"],
      requiredSkills: [],
      requiredAgents: [],
      approvalPolicy: {},
      supervision: { default: true },
      workflow: {},
      maxRunMinutes: 30,
      enabled: false
    });

    const payload = capabilityPayloadFromDefinition(definition);
    assert.equal(payload.slug, "build");
    assert.equal(payload.input_schema, '{"type":"object"}');
    assert.equal(payload.required_runner_tags, '["runner"]');
    assert.equal(payload.max_run_minutes, 30);
    assert.equal(payload.enabled, 0);
    assert.match(payload.definition_hash, /^[a-f0-9]{64}$/);
  });

  it("hashes semantically identical definitions the same way regardless of key order", () => {
    const first = normalizeCapabilityDefinition({
      slug: "same",
      name: "Same",
      workflow: { b: 2, a: 1 }
    });
    const second = normalizeCapabilityDefinition({
      name: "Same",
      slug: "same",
      workflow: { a: 1, b: 2 }
    });

    assert.equal(capabilityDefinitionHash(first), capabilityDefinitionHash(second));
  });

  it("builds capability list and lookup queries", () => {
    assert.deepEqual(capabilityListQuery(), {
      sql: "SELECT * FROM capabilities WHERE enabled = 1 ORDER BY category, name",
      params: []
    });
    assert.deepEqual(capabilityListQuery({ q: "deploy" }), {
      sql: "SELECT * FROM capabilities WHERE enabled = 1 AND (name LIKE ? OR slug LIKE ? OR description LIKE ? OR keywords LIKE ?) ORDER BY category, name",
      params: ["%deploy%", "%deploy%", "%deploy%", "%deploy%"]
    });
    assert.deepEqual(capabilityListQuery({ q: "deploy", includeDisabled: true }), {
      sql: "SELECT * FROM capabilities WHERE (name LIKE ? OR slug LIKE ? OR description LIKE ? OR keywords LIKE ?) ORDER BY category, name",
      params: ["%deploy%", "%deploy%", "%deploy%", "%deploy%"]
    });
    assert.deepEqual(capabilityLookupQuery("cap_1"), {
      sql: "SELECT * FROM capabilities WHERE slug = ? OR id = ?",
      params: ["cap_1", "cap_1"]
    });
    assert.deepEqual(capabilitySlugQuery("deploy"), {
      sql: "SELECT * FROM capabilities WHERE slug = ?",
      params: ["deploy"]
    });
    assert.deepEqual(capabilityIdQuery("cap_1"), {
      sql: "SELECT * FROM capabilities WHERE id = ?",
      params: ["cap_1"]
    });
  });

  it("builds capability write and snapshot queries", () => {
    const payload = capabilityPayloadFromDefinition(normalizeCapabilityDefinition({
      slug: "build",
      name: "Build",
      workflow: { steps: [] }
    }));
    const versionedPayload = { ...payload, version: 2, updated_at: "2026-01-01T00:00:00.000Z" };

    assert.deepEqual(capabilityDefinitionHashUpdateQuery({ slug: "build", definitionHash: "hash" }), {
      sql: "UPDATE capabilities SET definition_hash = ? WHERE slug = ?",
      params: ["hash", "build"]
    });
    assert.deepEqual(capabilityUpdateQuery(versionedPayload), {
      sql: `UPDATE capabilities SET name=$name, description=$description, category=$category, keywords=$keywords,
       input_schema=$input_schema, output_schema=$output_schema, required_runner_tags=$required_runner_tags,
       required_skills=$required_skills, required_agents=$required_agents, approval_policy=$approval_policy,
       supervision=$supervision, workflow=$workflow, max_run_minutes=$max_run_minutes, definition_hash=$definition_hash, enabled=$enabled, version=$version, updated_at=$updated_at WHERE slug=$slug`,
      params: versionedPayload
    });
    assert.deepEqual(capabilityInsertQuery(), {
      sql: `INSERT INTO capabilities
     (id, slug, name, description, category, keywords, input_schema, output_schema, required_runner_tags,
      required_skills, required_agents, approval_policy, supervision, workflow, max_run_minutes, definition_hash, version, enabled, created_at, updated_at)
     VALUES ($id, $slug, $name, $description, $category, $keywords, $input_schema, $output_schema,
      $required_runner_tags, $required_skills, $required_agents, $approval_policy, $supervision, $workflow, $max_run_minutes, $definition_hash, $version,
      $enabled, $created_at, $updated_at)`
    });
    assert.deepEqual(capabilityVersionInsertQuery({
      id: "capv_1",
      capabilityId: "cap_1",
      version: 2,
      snapshot: "{}",
      createdAt: "2026-01-01T00:00:00.000Z"
    }), {
      sql: "INSERT INTO capability_versions (id, capability_id, version, snapshot, created_at) VALUES (?, ?, ?, ?, ?)",
      params: ["capv_1", "cap_1", 2, "{}", "2026-01-01T00:00:00.000Z"]
    });
  });
});
