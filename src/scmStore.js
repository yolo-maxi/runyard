import {
  normalizeScmInstallation,
  normalizeScmRepo,
  normalizeScmWebhookDelivery,
  scmInstallationCreateRecord,
  scmInstallationInsertQuery,
  scmInstallationListQuery,
  scmInstallationLookupQuery,
  scmInstallationUpdateQuery,
  scmRepoCreateRecord,
  scmRepoInsertQuery,
  scmRepoListQuery,
  scmRepoLookupQuery,
  scmRepoSetEnabledQuery,
  scmRepoSetTrustPolicyQuery,
  scmRepoSyncQuery,
  scmRepoSyncValues,
  scmWebhookDeliveryCountQuery,
  scmWebhookDeliveryCreateRecord,
  scmWebhookDeliveryInsertQuery,
  scmWebhookDeliveryListQuery,
  scmWebhookDeliveryDeleteQuery,
  scmWebhookDeliveryLookupQuery,
  scmWebhookDeliveryPruneQuery,
  scmWebhookDeliveryUpdateQuery
} from "./scmRecords.js";

// SCM connection store: installations, CI repositories, and the webhook
// delivery ledger. Thin CRUD over scmRecords; no provider API calls and no
// token material ever passes through here.

export function createScmStore({ all, one, run, id, now }) {
  function getScmInstallation(installationId, { provider = "github" } = {}) {
    const query = scmInstallationLookupQuery(provider, installationId);
    return normalizeScmInstallation(one(query.sql, query.params));
  }

  function listScmInstallations() {
    const query = scmInstallationListQuery();
    return all(query.sql, query.params).map(normalizeScmInstallation);
  }

  // Idempotent identity sync from installation webhooks or a manual sync.
  function upsertScmInstallation(input) {
    const provider = input.provider || "github";
    const existing = getScmInstallation(input.installationId, { provider });
    const timestamp = now();
    if (!existing) {
      const record = scmInstallationCreateRecord({ id: id("scminst"), input, timestamp });
      run(scmInstallationInsertQuery().sql, record);
      return getScmInstallation(input.installationId, { provider });
    }
    const query = scmInstallationUpdateQuery({
      provider,
      installationId: input.installationId,
      values: {
        account_login: input.accountLogin != null ? input.accountLogin : existing.accountLogin,
        account_type: input.accountType != null ? input.accountType : existing.accountType,
        app_id: input.appId != null ? String(input.appId) : existing.appId,
        status: input.status != null ? input.status : existing.status,
        updated_at: timestamp
      }
    });
    run(query.sql, query.params);
    return getScmInstallation(input.installationId, { provider });
  }

  function getScmRepo(idOrFullName, { provider = "github" } = {}) {
    const query = scmRepoLookupQuery(idOrFullName, { provider });
    return normalizeScmRepo(one(query.sql, query.params));
  }

  function listScmRepos(options = {}) {
    const query = scmRepoListQuery(options);
    return all(query.sql, query.params).map(normalizeScmRepo);
  }

  // Identity sync (create or metadata update). Never touches the
  // operator-owned enabled/trustPolicy flags on an existing row.
  function upsertScmRepo(input) {
    const provider = input.provider || "github";
    const lookup = scmRepoLookupQuery(input.fullName, { provider });
    const existing = one(lookup.sql, lookup.params);
    const timestamp = now();
    if (!existing) {
      const record = scmRepoCreateRecord({ id: id("repo"), input, timestamp });
      run(scmRepoInsertQuery().sql, record);
      return getScmRepo(record.id);
    }
    const query = scmRepoSyncQuery({
      repoId: existing.id,
      values: scmRepoSyncValues(existing, input, timestamp)
    });
    run(query.sql, query.params);
    return getScmRepo(existing.id);
  }

  function setScmRepoEnabled(repoId, enabled) {
    const existing = getScmRepo(repoId);
    if (!existing) return null;
    const query = scmRepoSetEnabledQuery({ repoId: existing.id, enabled, timestamp: now() });
    run(query.sql, query.params);
    return getScmRepo(existing.id);
  }

  function setScmRepoTrustPolicy(repoId, trustPolicy) {
    const existing = getScmRepo(repoId);
    if (!existing) return null;
    const query = scmRepoSetTrustPolicyQuery({ repoId: existing.id, trustPolicy, timestamp: now() });
    run(query.sql, query.params);
    return getScmRepo(existing.id);
  }

  function findScmWebhookDelivery(deliveryId, { provider = "github" } = {}) {
    const query = scmWebhookDeliveryLookupQuery(provider, deliveryId);
    return normalizeScmWebhookDelivery(one(query.sql, query.params));
  }

  function recordScmWebhookDelivery(input) {
    const record = scmWebhookDeliveryCreateRecord({ id: id("scmdel"), input, timestamp: now() });
    run(scmWebhookDeliveryInsertQuery().sql, record);
    return findScmWebhookDelivery(input.deliveryId, { provider: input.provider || "github" });
  }

  function updateScmWebhookDelivery(deliveryId, { status, action, repoFullName, detail, pipelineId } = {}, { provider = "github" } = {}) {
    const query = scmWebhookDeliveryUpdateQuery({ provider, deliveryId, status, action, repoFullName, detail, pipelineId });
    run(query.sql, query.params);
    return findScmWebhookDelivery(deliveryId, { provider });
  }

  function deleteScmWebhookDelivery(deliveryId, { provider = "github" } = {}) {
    const query = scmWebhookDeliveryDeleteQuery(provider, deliveryId);
    return run(query.sql, query.params).changes;
  }

  function listScmWebhookDeliveries(options = {}) {
    const query = scmWebhookDeliveryListQuery(options);
    return all(query.sql, query.params).map(normalizeScmWebhookDelivery);
  }

  function countScmWebhookDeliveries(options = {}) {
    const query = scmWebhookDeliveryCountQuery(options);
    return one(query.sql, query.params).count;
  }

  function pruneScmWebhookDeliveries(cutoffIso) {
    const query = scmWebhookDeliveryPruneQuery(cutoffIso);
    return run(query.sql, query.params).changes;
  }

  return {
    countScmWebhookDeliveries,
    deleteScmWebhookDelivery,
    findScmWebhookDelivery,
    getScmInstallation,
    getScmRepo,
    listScmInstallations,
    listScmRepos,
    listScmWebhookDeliveries,
    pruneScmWebhookDeliveries,
    recordScmWebhookDelivery,
    setScmRepoEnabled,
    setScmRepoTrustPolicy,
    updateScmWebhookDelivery,
    upsertScmInstallation,
    upsertScmRepo
  };
}
