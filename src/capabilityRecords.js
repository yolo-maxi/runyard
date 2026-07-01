import { createHash } from "node:crypto";
import { normalizeMaxRunMinutes, parseMaybeJson } from "./dbNormalization.js";
import { stableJsonString } from "./stableJson.js";

function parseJsonField(value, fallback) {
  return parseMaybeJson(value, fallback);
}

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function normalizeCapability(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    keywords: parseJsonField(row.keywords, []),
    inputSchema: parseJsonField(row.input_schema, {}),
    outputSchema: parseJsonField(row.output_schema, {}),
    requiredRunnerTags: parseJsonField(row.required_runner_tags, []),
    requiredSkills: parseJsonField(row.required_skills, []),
    requiredAgents: parseJsonField(row.required_agents, []),
    approvalPolicy: parseJsonField(row.approval_policy, {}),
    supervision: parseJsonField(row.supervision, {}),
    workflow: parseJsonField(row.workflow, {}),
    maxRunMinutes: row.max_run_minutes ?? null,
    definitionHash: row.definition_hash || "",
    version: row.version,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function normalizeCapabilityDefinition(input) {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description || "",
    category: input.category || "General",
    keywords: parseJsonField(input.keywords, []),
    inputSchema: parseJsonField(input.inputSchema ?? input.input_schema, {}),
    outputSchema: parseJsonField(input.outputSchema ?? input.output_schema, {}),
    requiredRunnerTags: parseJsonField(input.requiredRunnerTags ?? input.required_runner_tags, []),
    requiredSkills: parseJsonField(input.requiredSkills ?? input.required_skills, []),
    requiredAgents: parseJsonField(input.requiredAgents ?? input.required_agents, []),
    approvalPolicy: parseJsonField(input.approvalPolicy ?? input.approval_policy, {}),
    supervision: parseJsonField(input.supervision ?? input.supervision_policy, {}),
    workflow: parseJsonField(input.workflow, {}),
    maxRunMinutes: normalizeMaxRunMinutes(input.maxRunMinutes ?? input.max_run_minutes),
    enabled: input.enabled === false || input.enabled === 0 ? false : true
  };
}

export function capabilityDefinitionHash(definition) {
  return createHash("sha256").update(stableJsonString(definition)).digest("hex");
}

export function capabilityPayloadFromDefinition(definition) {
  return {
    slug: definition.slug,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    keywords: jsonField(definition.keywords, []),
    input_schema: jsonField(definition.inputSchema, {}),
    output_schema: jsonField(definition.outputSchema, {}),
    required_runner_tags: jsonField(definition.requiredRunnerTags, []),
    required_skills: jsonField(definition.requiredSkills, []),
    required_agents: jsonField(definition.requiredAgents, []),
    approval_policy: jsonField(definition.approvalPolicy, {}),
    supervision: jsonField(definition.supervision, {}),
    workflow: jsonField(definition.workflow, {}),
    max_run_minutes: definition.maxRunMinutes ?? null,
    definition_hash: capabilityDefinitionHash(definition),
    enabled: definition.enabled ? 1 : 0
  };
}

export function capabilityDefinitionHashUpdateQuery({ slug, definitionHash }) {
  return {
    sql: "UPDATE capabilities SET definition_hash = ? WHERE slug = ?",
    params: [definitionHash, slug]
  };
}

export function capabilityUpdateQuery(payload) {
  return {
    sql: `UPDATE capabilities SET name=$name, description=$description, category=$category, keywords=$keywords,
       input_schema=$input_schema, output_schema=$output_schema, required_runner_tags=$required_runner_tags,
       required_skills=$required_skills, required_agents=$required_agents, approval_policy=$approval_policy,
       supervision=$supervision, workflow=$workflow, max_run_minutes=$max_run_minutes, definition_hash=$definition_hash, enabled=$enabled, version=$version, updated_at=$updated_at WHERE slug=$slug`,
    params: payload
  };
}

export function capabilityInsertQuery() {
  return {
    sql: `INSERT INTO capabilities
     (id, slug, name, description, category, keywords, input_schema, output_schema, required_runner_tags,
      required_skills, required_agents, approval_policy, supervision, workflow, max_run_minutes, definition_hash, version, enabled, created_at, updated_at)
     VALUES ($id, $slug, $name, $description, $category, $keywords, $input_schema, $output_schema,
      $required_runner_tags, $required_skills, $required_agents, $approval_policy, $supervision, $workflow, $max_run_minutes, $definition_hash, $version,
      $enabled, $created_at, $updated_at)`
  };
}

export function capabilityVersionInsertQuery({ id, capabilityId, version, snapshot, createdAt }) {
  return {
    sql: "INSERT INTO capability_versions (id, capability_id, version, snapshot, created_at) VALUES (?, ?, ?, ?, ?)",
    params: [id, capabilityId, version, snapshot, createdAt]
  };
}

export function capabilityListQuery({ q = "", includeDisabled = false } = {}) {
  const search = String(q || "");
  const where = [];
  const params = [];
  if (!includeDisabled) where.push("enabled = 1");
  if (search) {
    where.push("(name LIKE ? OR slug LIKE ? OR description LIKE ? OR keywords LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  return {
    sql: `SELECT * FROM capabilities ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY category, name`,
    params
  };
}

export function capabilityLookupQuery(slugOrId) {
  return {
    sql: "SELECT * FROM capabilities WHERE slug = ? OR id = ?",
    params: [slugOrId, slugOrId]
  };
}

export function capabilitySlugQuery(slug) {
  return {
    sql: "SELECT * FROM capabilities WHERE slug = ?",
    params: [slug]
  };
}

export function capabilityIdQuery(capabilityId) {
  return {
    sql: "SELECT * FROM capabilities WHERE id = ?",
    params: [capabilityId]
  };
}
