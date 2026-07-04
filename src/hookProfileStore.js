import {
  hookProfileDefinitionHash,
  hookProfileInsertQuery,
  hookProfileListQuery,
  hookProfileLookupQuery,
  hookProfilePayloadFromDefinition,
  hookProfileSlugQuery,
  hookProfileUpdateQuery,
  normalizeHookProfile,
  validateHookProfileDefinition
} from "./hookProfileRecords.js";

export function createHookProfileStore({ all, one, run, id, now }) {
  function listHookProfiles({ includeDisabled = false } = {}) {
    const query = hookProfileListQuery({ includeDisabled });
    return all(query.sql, query.params).map(normalizeHookProfile);
  }

  function getHookProfile(slugOrId) {
    const query = hookProfileLookupQuery(slugOrId);
    return normalizeHookProfile(one(query.sql, query.params));
  }

  // Validates before touching storage; invalid definitions never persist.
  // Returns { ok:false, errors } or { ok:true, hookProfile }.
  function upsertHookProfile(input) {
    const validated = validateHookProfileDefinition(input);
    if (!validated.ok) return { ok: false, errors: validated.errors };
    const definition = validated.definition;
    const timestamp = now();
    const payload = {
      ...hookProfilePayloadFromDefinition(definition),
      updated_at: timestamp
    };

    const existingQuery = hookProfileSlugQuery(definition.slug);
    const existing = one(existingQuery.sql, existingQuery.params);
    if (existing) {
      if (existing.definition_hash === payload.definition_hash) {
        return { ok: true, hookProfile: getHookProfile(definition.slug) };
      }
      const query = hookProfileUpdateQuery({ ...payload, version: existing.version + 1 });
      run(query.sql, query.params);
      return { ok: true, hookProfile: getHookProfile(definition.slug) };
    }

    const created = { id: id("hook"), version: 1, created_at: timestamp, ...payload };
    const query = hookProfileInsertQuery();
    run(query.sql, created);
    return { ok: true, hookProfile: getHookProfile(definition.slug) };
  }

  return {
    getHookProfile,
    listHookProfiles,
    upsertHookProfile
  };
}

export { hookProfileDefinitionHash };
