import {
  allSecretEncryptedValuesQuery,
  normalizeSecretMeta,
  secretDeleteQuery,
  secretEncryptedValueQuery,
  secretExistingMetaQuery,
  secretInsertQuery,
  secretKeyQuery,
  secretMetaListQuery,
  secretMetaQuery,
  secretUpdateQuery,
  secretUpsertParams,
  uniqueSecretNames
} from "./secretRecords.js";

export function createSecretStore({
  all,
  one,
  run,
  now,
  encrypt,
  decrypt,
  redactSecrets,
  secretsEnabled
}) {
  function listSecretMeta() {
    const query = secretMetaListQuery();
    return all(query.sql, query.params).map(normalizeSecretMeta);
  }

  function secretExists(key) {
    const query = secretKeyQuery(key);
    return Boolean(one(query.sql, query.params));
  }

  function getSecretMeta(key) {
    const query = secretMetaQuery(key);
    return normalizeSecretMeta(one(query.sql, query.params));
  }

  function upsertSecret({ key, value, description = "", createdBy = "" }) {
    const payload = secretUpsertParams({
      key,
      encryptedValue: encrypt(String(value ?? "")),
      description,
      createdBy,
      timestamp: now()
    });
    if (!payload.key) throw new Error("secret key is required");
    const existingQuery = secretExistingMetaQuery(payload.key);
    const existing = one(existingQuery.sql, existingQuery.params);
    const query = existing ? secretUpdateQuery(payload) : secretInsertQuery(payload);
    run(query.sql, query.params);
    return getSecretMeta(payload.key);
  }

  function deleteSecret(key) {
    const query = secretDeleteQuery(key);
    const result = run(query.sql, query.params);
    return result.changes > 0;
  }

  function getDecryptedSecretEnv(names = []) {
    if (!secretsEnabled()) return {};
    const env = {};
    for (const key of uniqueSecretNames(names)) {
      const query = secretEncryptedValueQuery(key);
      const row = one(query.sql, query.params);
      if (!row) continue;
      try {
        env[key] = decrypt(row.value_encrypted);
      } catch {
        // Rotated or corrupt encryption keys should not prevent run claims.
      }
    }
    return env;
  }

  function allSecretValues() {
    if (!secretsEnabled()) return [];
    const values = [];
    const query = allSecretEncryptedValuesQuery();
    for (const row of all(query.sql, query.params)) {
      try {
        values.push(decrypt(row.value_encrypted));
      } catch {
        // Skip undecryptable rows so one bad secret cannot block persistence.
      }
    }
    return values;
  }

  function scrubStoredSecrets(value) {
    const values = allSecretValues();
    if (!values.length) return value;
    return redactSecrets(value, values);
  }

  return {
    allSecretValues,
    deleteSecret,
    getDecryptedSecretEnv,
    getSecretMeta,
    listSecretMeta,
    scrubStoredSecrets,
    secretExists,
    upsertSecret
  };
}
