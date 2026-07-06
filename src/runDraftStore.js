import {
  normalizeRunDraft,
  RUN_DRAFT_DISCARDED,
  RUN_DRAFT_SUBMITTED,
  runDraftInsertQuery,
  runDraftListQuery,
  runDraftLookupQuery,
  runDraftUpdateQuery
} from "./runDraftRecords.js";

export function createRunDraftStore({ all, one, run, id, now, scrubStoredSecrets }) {
  const storedJson = (value, fallback) =>
    JSON.stringify(scrubStoredSecrets(value && typeof value === "object" ? value : fallback));

  function getRunDraft(draftId) {
    const query = runDraftLookupQuery(draftId);
    return normalizeRunDraft(one(query.sql, query.params));
  }

  function createRunDraft({ capabilitySlug, input = {}, options = {}, status, preflight = {}, createdBy = "" }) {
    const draftId = id("draft");
    const timestamp = now();
    const query = runDraftInsertQuery();
    run(query.sql, {
      id: draftId,
      capability_slug: capabilitySlug,
      input: storedJson(input, {}),
      options: storedJson(options, {}),
      status,
      preflight: JSON.stringify(preflight ?? {}),
      created_by: createdBy,
      run_id: null,
      created_at: timestamp,
      updated_at: timestamp
    });
    return getRunDraft(draftId);
  }

  function updateRunDraft(draftId, { input, options, status, preflight, runId } = {}) {
    const existing = getRunDraft(draftId);
    if (!existing) return null;
    const query = runDraftUpdateQuery();
    run(query.sql, {
      id: draftId,
      input: storedJson(input ?? existing.input, {}),
      options: storedJson(options ?? existing.options, {}),
      status: status ?? existing.status,
      preflight: JSON.stringify(preflight ?? existing.preflight ?? {}),
      run_id: runId ?? existing.runId,
      updated_at: now()
    });
    return getRunDraft(draftId);
  }

  function markRunDraftSubmitted(draftId, { runId, preflight } = {}) {
    return updateRunDraft(draftId, { status: RUN_DRAFT_SUBMITTED, runId, preflight });
  }

  function discardRunDraft(draftId) {
    return updateRunDraft(draftId, { status: RUN_DRAFT_DISCARDED });
  }

  function listRunDrafts({ status = "", capability = "", limit = 50 } = {}) {
    const query = runDraftListQuery({ status, capability, limit });
    return all(query.sql, query.params).map(normalizeRunDraft);
  }

  return {
    createRunDraft,
    discardRunDraft,
    getRunDraft,
    listRunDrafts,
    markRunDraftSubmitted,
    updateRunDraft
  };
}
