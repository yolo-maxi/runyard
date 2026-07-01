import {
  agentInsertQuery,
  agentLookupQuery,
  agentPayload,
  agentListQuery,
  agentUpdateQuery,
  knowledgeInsertQuery,
  knowledgeLookupQuery,
  knowledgeListQuery,
  knowledgePayload,
  knowledgeUpdateQuery,
  normalizeEditable,
  normalizeKnowledge,
  skillInsertQuery,
  skillListQuery,
  skillLookupQuery,
  skillPayload,
  skillUpdateQuery
} from "./catalogRecords.js";

function createEditableCatalogAccess({
  listQuery,
  lookupQuery,
  insertQuery,
  updateQuery,
  payload,
  normalize,
  idPrefix,
  deps
}) {
  const { all, one, run, id, now } = deps;

  function list(q = "") {
    const query = listQuery(q);
    return all(query.sql, query.params).map(normalize);
  }

  function get(slug) {
    const query = lookupQuery(slug);
    return normalize(one(query.sql, query.params));
  }

  function upsert(input) {
    const lookup = lookupQuery(input.slug);
    const existing = one(lookup.sql, lookup.params);
    const timestamp = now();
    const record = payload(input, timestamp);
    if (existing) {
      run(updateQuery().sql, record);
    } else {
      run(insertQuery().sql, { id: id(idPrefix), created_at: timestamp, ...record });
    }
    return list(input.slug)[0];
  }

  return { get, list, upsert };
}

export function createCatalogStore(deps) {
  const agents = createEditableCatalogAccess({
    listQuery: agentListQuery,
    lookupQuery: agentLookupQuery,
    insertQuery: agentInsertQuery,
    updateQuery: agentUpdateQuery,
    payload: agentPayload,
    normalize: (row) => normalizeEditable(row, ["id", "slug", "name", "description", "instructions"]),
    idPrefix: "agent",
    deps
  });

  const skills = createEditableCatalogAccess({
    listQuery: skillListQuery,
    lookupQuery: skillLookupQuery,
    insertQuery: skillInsertQuery,
    updateQuery: skillUpdateQuery,
    payload: skillPayload,
    normalize: (row) => normalizeEditable(row, ["id", "slug", "name", "description", "body"]),
    idPrefix: "skill",
    deps
  });

  const knowledge = createEditableCatalogAccess({
    listQuery: knowledgeListQuery,
    lookupQuery: knowledgeLookupQuery,
    insertQuery: knowledgeInsertQuery,
    updateQuery: knowledgeUpdateQuery,
    payload: knowledgePayload,
    normalize: normalizeKnowledge,
    idPrefix: "know",
    deps
  });

  return {
    getAgent: agents.get,
    listAgents: agents.list,
    upsertAgent: agents.upsert,
    getSkill: skills.get,
    listSkills: skills.list,
    upsertSkill: skills.upsert,
    listKnowledge: knowledge.list,
    upsertKnowledge: knowledge.upsert
  };
}
