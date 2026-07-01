import { parseMaybeJson } from "./dbNormalization.js";
import { hashToken } from "./security.js";

function jsonField(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function accessTokenRecord({
  id,
  name,
  token,
  scopes = ["api"],
  expiresAt = null,
  timestamp
}) {
  return {
    id,
    name,
    token_hash: hashToken(token),
    scopes: jsonField(scopes, []),
    created_at: timestamp,
    expires_at: expiresAt || null
  };
}

export function accessTokenLookupHash(token) {
  return hashToken(token);
}

export function accessTokenInsertQuery() {
  return {
    sql: "INSERT INTO access_tokens (id, name, token_hash, scopes, created_at, expires_at) VALUES ($id, $name, $token_hash, $scopes, $created_at, $expires_at)"
  };
}

export function accessTokenCountQuery() {
  return {
    sql: "SELECT COUNT(*) AS count FROM access_tokens",
    params: []
  };
}

export function accessTokenListQuery() {
  return {
    sql: "SELECT id, name, scopes, created_at, last_used_at, revoked_at, expires_at FROM access_tokens ORDER BY created_at DESC",
    params: []
  };
}

export function accessTokenLookupQuery(tokenId) {
  return {
    sql: "SELECT * FROM access_tokens WHERE id = ?",
    params: [tokenId]
  };
}

export function accessTokenRevocationLookupQuery(tokenId) {
  return {
    sql: "SELECT id, revoked_at FROM access_tokens WHERE id = ?",
    params: [tokenId]
  };
}

export function accessTokenRevokeQuery({ tokenId, timestamp }) {
  return {
    sql: "UPDATE access_tokens SET revoked_at = ? WHERE id = ?",
    params: [timestamp, tokenId]
  };
}

export function accessTokenAuthenticationQuery({ tokenHash, nowIso }) {
  return {
    sql: "SELECT * FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    params: [tokenHash, nowIso]
  };
}

export function accessTokenLastUsedUpdateQuery({ tokenId, timestamp }) {
  return {
    sql: "UPDATE access_tokens SET last_used_at = ? WHERE id = ?",
    params: [timestamp, tokenId]
  };
}

export function accessTokenCreateResponse(record, token, scopes = []) {
  return {
    id: record.id,
    name: record.name,
    token,
    scopes,
    createdAt: record.created_at,
    expiresAt: record.expires_at
  };
}

export function normalizeToken(row, { nowIso } = {}) {
  if (!row) return null;
  const expired = Boolean(row.expires_at && nowIso && row.expires_at <= nowIso);
  return {
    id: row.id,
    name: row.name,
    scopes: parseMaybeJson(row.scopes, []),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    active: !row.revoked_at && !expired
  };
}

export function authenticatedToken(row) {
  if (!row) return null;
  return {
    ...row,
    scopes: parseMaybeJson(row.scopes, [])
  };
}
