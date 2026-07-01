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
} from "./capabilityRecords.js";

export function createCapabilityStore({ all, one, run, id, now }) {
  function listCapabilities({ q = "", includeDisabled = false } = {}) {
    const query = capabilityListQuery({ q, includeDisabled });
    return all(query.sql, query.params).map(normalizeCapability);
  }

  function getCapability(slugOrId) {
    const query = capabilityLookupQuery(slugOrId);
    return normalizeCapability(one(query.sql, query.params));
  }

  function snapshotCapability(capabilityId) {
    const query = capabilityIdQuery(capabilityId);
    const capability = one(query.sql, query.params);
    if (!capability) return;
    const insert = capabilityVersionInsertQuery({
      id: id("capv"),
      capabilityId,
      version: capability.version,
      snapshot: JSON.stringify(normalizeCapability(capability)),
      createdAt: now()
    });
    run(insert.sql, insert.params);
  }

  function upsertCapability(input) {
    const existingQuery = capabilitySlugQuery(input.slug);
    const existing = one(existingQuery.sql, existingQuery.params);
    const timestamp = now();
    const definition = normalizeCapabilityDefinition(input);
    const payload = {
      ...capabilityPayloadFromDefinition(definition),
      updated_at: timestamp
    };
    const definitionHash = payload.definition_hash;

    if (existing) {
      const existingHash = existing.definition_hash || capabilityDefinitionHash(normalizeCapabilityDefinition(normalizeCapability(existing)));
      if (existingHash === definitionHash) {
        if (existing.definition_hash !== definitionHash) {
          const query = capabilityDefinitionHashUpdateQuery({ slug: input.slug, definitionHash });
          run(query.sql, query.params);
        }
        return getCapability(input.slug);
      }
      const version = existing.version + 1;
      const query = capabilityUpdateQuery({ ...payload, version });
      run(query.sql, query.params);
      snapshotCapability(existing.id);
      return getCapability(input.slug);
    }

    const created = { id: id("cap"), version: 1, created_at: timestamp, ...payload };
    const query = capabilityInsertQuery();
    run(query.sql, created);
    snapshotCapability(created.id);
    return getCapability(input.slug);
  }

  return {
    getCapability,
    listCapabilities,
    upsertCapability
  };
}
