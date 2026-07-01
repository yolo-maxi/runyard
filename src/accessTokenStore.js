import {
  accessTokenAuthenticationQuery,
  accessTokenCreateResponse,
  accessTokenInsertQuery,
  accessTokenLastUsedUpdateQuery,
  accessTokenListQuery,
  accessTokenLookupHash,
  accessTokenLookupQuery,
  accessTokenRecord,
  accessTokenRevocationLookupQuery,
  accessTokenRevokeQuery,
  authenticatedToken,
  normalizeToken
} from "./accessTokenRecords.js";

export function createAccessTokenStore({ all, one, run, id, now, randomToken }) {
  function createAccessToken(name, token = randomToken(), scopes = ["api"], options = {}) {
    const record = accessTokenRecord({
      id: id("tok"),
      name,
      token,
      scopes,
      expiresAt: options.expiresAt,
      timestamp: now()
    });
    const query = accessTokenInsertQuery();
    run(query.sql, record);
    return accessTokenCreateResponse(record, token, scopes);
  }

  function listAccessTokens() {
    const query = accessTokenListQuery();
    const nowIso = now();
    return all(query.sql, query.params).map((row) => normalizeToken(row, { nowIso }));
  }

  function getAccessToken(tokenId) {
    const query = accessTokenLookupQuery(tokenId);
    return normalizeToken(one(query.sql, query.params), { nowIso: now() });
  }

  function revokeAccessToken(tokenId) {
    const lookup = accessTokenRevocationLookupQuery(tokenId);
    const existing = one(lookup.sql, lookup.params);
    if (!existing) return null;
    if (!existing.revoked_at) {
      const query = accessTokenRevokeQuery({ tokenId, timestamp: now() });
      run(query.sql, query.params);
    }
    return getAccessToken(tokenId);
  }

  function authenticateToken(token) {
    if (!token) return null;
    const query = accessTokenAuthenticationQuery({ tokenHash: accessTokenLookupHash(token), nowIso: now() });
    const record = one(query.sql, query.params);
    if (!record) return null;
    const update = accessTokenLastUsedUpdateQuery({ tokenId: record.id, timestamp: now() });
    run(update.sql, update.params);
    return authenticatedToken(record);
  }

  return {
    authenticateToken,
    createAccessToken,
    getAccessToken,
    listAccessTokens,
    revokeAccessToken
  };
}
