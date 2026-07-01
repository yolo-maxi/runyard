import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAccessTokenStore } from "../src/accessTokenStore.js";
import { accessTokenLookupHash } from "../src/accessTokenRecords.js";

const tokenRow = {
  id: "tok_1",
  name: "API",
  token_hash: accessTokenLookupHash("secret-token"),
  scopes: '["api","admin"]',
  created_at: "2026-07-01T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
  expires_at: null
};

function createHarness({ oneRows = [tokenRow], allRows = [tokenRow], generatedToken = "generated-token" } = {}) {
  const calls = [];
  const rows = [...oneRows];
  const store = createAccessTokenStore({
    all: (sql, params) => {
      calls.push({ fn: "all", sql, params });
      return allRows;
    },
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return rows.length ? rows.shift() : null;
    },
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: 1 };
    },
    id: (prefix) => `${prefix}_1`,
    now: () => "2026-07-01T00:00:00.000Z",
    randomToken: () => generatedToken
  });
  return { calls, store };
}

describe("access token store", () => {
  it("creates tokens and returns the clear token once", () => {
    const { calls, store } = createHarness();

    const created = store.createAccessToken("CI", undefined, ["api"], {
      expiresAt: "2026-08-01T00:00:00.000Z"
    });

    assert.deepEqual(created, {
      id: "tok_1",
      name: "CI",
      token: "generated-token",
      scopes: ["api"],
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z"
    });
    const write = calls.find((call) => call.fn === "run");
    assert.equal(write.params.id, "tok_1");
    assert.equal(write.params.name, "CI");
    assert.equal(write.params.token_hash, accessTokenLookupHash("generated-token"));
  });

  it("lists and loads normalized tokens", () => {
    const { store } = createHarness();

    assert.deepEqual(store.listAccessTokens().map((token) => token.id), ["tok_1"]);
    assert.deepEqual(store.getAccessToken("tok_1"), {
      id: "tok_1",
      name: "API",
      scopes: ["api", "admin"],
      createdAt: "2026-07-01T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      active: true
    });
  });

  it("revokes active tokens and returns missing tokens as null", () => {
    const { calls, store } = createHarness({ oneRows: [tokenRow, { ...tokenRow, revoked_at: "2026-07-01T00:00:00.000Z" }] });

    const revoked = store.revokeAccessToken("tok_1");

    assert.equal(revoked.revokedAt, "2026-07-01T00:00:00.000Z");
    assert.ok(calls.some((call) => call.fn === "run" && call.sql.startsWith("UPDATE access_tokens SET revoked_at")));
    assert.equal(createHarness({ oneRows: [null] }).store.revokeAccessToken("missing"), null);
  });

  it("does not rewrite already revoked tokens", () => {
    const { calls, store } = createHarness({
      oneRows: [{ id: "tok_1", revoked_at: "2026-07-01T00:00:00.000Z" }, { ...tokenRow, revoked_at: "2026-07-01T00:00:00.000Z" }]
    });

    assert.equal(store.revokeAccessToken("tok_1").active, false);
    assert.equal(calls.some((call) => call.fn === "run"), false);
  });

  it("authenticates active tokens and records last use", () => {
    const { calls, store } = createHarness();

    assert.deepEqual(store.authenticateToken("secret-token").scopes, ["api", "admin"]);
    assert.ok(calls.some((call) => call.fn === "run" && call.sql.startsWith("UPDATE access_tokens SET last_used_at")));
    assert.equal(createHarness().store.authenticateToken(""), null);
    assert.equal(createHarness({ oneRows: [null] }).store.authenticateToken("missing"), null);
  });
});
