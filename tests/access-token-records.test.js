import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  accessTokenAuthenticationQuery,
  accessTokenCountQuery,
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
} from "../src/accessTokenRecords.js";

describe("access token record helpers", () => {
  it("builds persisted token records and create responses", () => {
    const record = accessTokenRecord({
      id: "tok_1",
      name: "CI",
      token: "secret-token",
      scopes: ["api", "admin"],
      expiresAt: "2026-02-01T00:00:00.000Z",
      timestamp: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(record.id, "tok_1");
    assert.equal(record.name, "CI");
    assert.notEqual(record.token_hash, "secret-token");
    assert.equal(record.token_hash, accessTokenLookupHash("secret-token"));
    assert.equal(record.scopes, '["api","admin"]');

    assert.deepEqual(accessTokenCreateResponse(record, "secret-token", ["api", "admin"]), {
      id: "tok_1",
      name: "CI",
      token: "secret-token",
      scopes: ["api", "admin"],
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z"
    });
  });

  it("normalizes token presentation state", () => {
    const row = {
      id: "tok_1",
      name: "API",
      scopes: '["api","admin"]',
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
      expires_at: "2026-02-01T00:00:00.000Z"
    };

    assert.deepEqual(normalizeToken(row, { nowIso: "2026-01-15T00:00:00.000Z" }).scopes, ["api", "admin"]);
    assert.equal(normalizeToken(row, { nowIso: "2026-01-15T00:00:00.000Z" }).active, true);
    assert.equal(normalizeToken({ ...row, expires_at: "2026-01-01T00:00:00.000Z" }, {
      nowIso: "2026-01-15T00:00:00.000Z"
    }).active, false);
    assert.equal(normalizeToken({ ...row, revoked_at: "2026-01-10T00:00:00.000Z" }, {
      nowIso: "2026-01-15T00:00:00.000Z"
    }).active, false);
  });

  it("parses authenticated token scopes for middleware callers", () => {
    assert.equal(authenticatedToken(null), null);
    assert.deepEqual(authenticatedToken({ id: "tok_1", scopes: '["runner"]' }), {
      id: "tok_1",
      scopes: ["runner"]
    });
  });

  it("builds access token persistence queries", () => {
    assert.deepEqual(accessTokenInsertQuery(), {
      sql: "INSERT INTO access_tokens (id, name, token_hash, scopes, created_at, expires_at) VALUES ($id, $name, $token_hash, $scopes, $created_at, $expires_at)"
    });
    assert.deepEqual(accessTokenCountQuery(), {
      sql: "SELECT COUNT(*) AS count FROM access_tokens",
      params: []
    });
    assert.deepEqual(accessTokenListQuery(), {
      sql: "SELECT id, name, scopes, created_at, last_used_at, revoked_at, expires_at FROM access_tokens ORDER BY created_at DESC",
      params: []
    });
    assert.deepEqual(accessTokenLookupQuery("tok_1"), {
      sql: "SELECT * FROM access_tokens WHERE id = ?",
      params: ["tok_1"]
    });
    assert.deepEqual(accessTokenRevocationLookupQuery("tok_1"), {
      sql: "SELECT id, revoked_at FROM access_tokens WHERE id = ?",
      params: ["tok_1"]
    });
    assert.deepEqual(accessTokenRevokeQuery({ tokenId: "tok_1", timestamp: "2026-01-01T00:00:00.000Z" }), {
      sql: "UPDATE access_tokens SET revoked_at = ? WHERE id = ?",
      params: ["2026-01-01T00:00:00.000Z", "tok_1"]
    });
  });

  it("builds access token authentication queries", () => {
    assert.deepEqual(accessTokenAuthenticationQuery({ tokenHash: "hash", nowIso: "2026-01-01T00:00:00.000Z" }), {
      sql: "SELECT * FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      params: ["hash", "2026-01-01T00:00:00.000Z"]
    });
    assert.deepEqual(accessTokenLastUsedUpdateQuery({ tokenId: "tok_1", timestamp: "2026-01-01T00:00:00.000Z" }), {
      sql: "UPDATE access_tokens SET last_used_at = ? WHERE id = ?",
      params: ["2026-01-01T00:00:00.000Z", "tok_1"]
    });
  });
});
