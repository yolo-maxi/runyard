import { normalizeToken } from "./accessTokenRecords.js";
import { parseMaybeJson } from "./dbNormalization.js";

export { normalizeToken } from "./accessTokenRecords.js";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function listQuery({ table, searchFields, orderBy }, q = "") {
  const search = String(q || "");
  if (!search) return { sql: `SELECT * FROM ${table} ORDER BY ${orderBy}`, params: [] };
  const like = `%${search}%`;
  return {
    sql: `SELECT * FROM ${table} WHERE ${searchFields.map((field) => `${field} LIKE ?`).join(" OR ")} ORDER BY ${orderBy}`,
    params: searchFields.map(() => like)
  };
}

export function agentListQuery(q = "") {
  return listQuery({ table: "agents", searchFields: ["name", "slug", "description"], orderBy: "name" }, q);
}

export function agentLookupQuery(slug) {
  return {
    sql: "SELECT * FROM agents WHERE slug = ?",
    params: [slug]
  };
}

export function agentUpdateQuery() {
  return {
    sql: `UPDATE agents SET name=$name, description=$description, instructions=$instructions, tools=$tools,
       skill_slugs=$skill_slugs, tags=$tags, enabled=$enabled, version=version+1, updated_at=$updated_at WHERE slug=$slug`
  };
}

export function agentInsertQuery() {
  return {
    sql: `INSERT INTO agents (id, slug, name, description, instructions, tools, skill_slugs, tags, enabled, created_at, updated_at)
       VALUES ($id, $slug, $name, $description, $instructions, $tools, $skill_slugs, $tags, $enabled, $created_at, $updated_at)`
  };
}

export function skillListQuery(q = "") {
  return listQuery({ table: "skills", searchFields: ["name", "slug", "description", "body"], orderBy: "name" }, q);
}

export function skillLookupQuery(slug) {
  return {
    sql: "SELECT * FROM skills WHERE slug = ?",
    params: [slug]
  };
}

export function skillUpdateQuery() {
  return {
    sql: "UPDATE skills SET name=$name, description=$description, body=$body, tags=$tags, enabled=$enabled, version=version+1, updated_at=$updated_at WHERE slug=$slug"
  };
}

export function skillInsertQuery() {
  return {
    sql: "INSERT INTO skills (id, slug, name, description, body, tags, enabled, created_at, updated_at) VALUES ($id, $slug, $name, $description, $body, $tags, $enabled, $created_at, $updated_at)"
  };
}

export function knowledgeListQuery(q = "") {
  return listQuery({ table: "knowledge_resources", searchFields: ["title", "slug", "body", "tags"], orderBy: "title" }, q);
}

export function knowledgeLookupQuery(slug) {
  return {
    sql: "SELECT * FROM knowledge_resources WHERE slug = ?",
    params: [slug]
  };
}

export function knowledgeUpdateQuery() {
  return {
    sql: "UPDATE knowledge_resources SET title=$title, type=$type, body=$body, url=$url, tags=$tags, updated_at=$updated_at WHERE slug=$slug"
  };
}

export function knowledgeInsertQuery() {
  return {
    sql: "INSERT INTO knowledge_resources (id, slug, title, type, body, url, tags, created_at, updated_at) VALUES ($id, $slug, $title, $type, $body, $url, $tags, $created_at, $updated_at)"
  };
}

export function normalizeEditable(row, fields) {
  if (!row) return null;
  const base = {};
  for (const field of fields) base[field] = row[field];
  return {
    ...base,
    tools: parseMaybeJson(row.tools, undefined),
    skillSlugs: parseMaybeJson(row.skill_slugs, undefined),
    tags: parseMaybeJson(row.tags, []),
    enabled: row.enabled == null ? undefined : Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version
  };
}

export function agentPayload(input, timestamp) {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description || "",
    instructions: input.instructions || "",
    tools: jsonField(input.tools, []),
    skill_slugs: jsonField(input.skillSlugs || input.skill_slugs || [], []),
    tags: jsonField(input.tags, []),
    enabled: input.enabled === false ? 0 : 1,
    updated_at: timestamp
  };
}

export function skillPayload(input, timestamp) {
  return {
    slug: input.slug,
    name: input.name,
    description: input.description || "",
    body: input.body || "",
    tags: jsonField(input.tags, []),
    enabled: input.enabled === false ? 0 : 1,
    updated_at: timestamp
  };
}

export function normalizeKnowledge(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type,
    body: row.body,
    url: row.url,
    tags: parseMaybeJson(row.tags, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function knowledgePayload(input, timestamp) {
  return {
    slug: input.slug,
    title: input.title,
    type: input.type || "doc",
    body: input.body || "",
    url: input.url || "",
    tags: jsonField(input.tags, []),
    updated_at: timestamp
  };
}
