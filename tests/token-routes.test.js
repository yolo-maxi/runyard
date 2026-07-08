import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TOKEN_SCOPES,
  KNOWN_TOKEN_SCOPES,
  TOKEN_PRESETS,
  TOKEN_SCOPE_METADATA,
  createTokenHandlers,
  revokeTokenDecision,
  tokenCreateInput
} from "../src/tokenRoutes.js";
import { mockResponse as response } from "./response.js";

function req({ body = {}, params = {}, token = { name: "Admin" } } = {}) {
  return { body, params, token };
}

function harness() {
  const audits = [];
  const tokens = [
    { id: "admin", active: true, scopes: ["admin"] },
    { id: "api", active: true, scopes: ["api"] }
  ];
  const handlers = createTokenHandlers({
    createAccessToken: (name, _raw, scopes, options) => {
      const token = { id: `tok_${tokens.length + 1}`, name, scopes, ...options };
      tokens.push({ ...token, active: true });
      return token;
    },
    listAccessTokens: () => tokens,
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    revokeAccessToken: (id) => {
      const token = tokens.find((entry) => entry.id === id);
      token.active = false;
      return token;
    }
  });
  return { audits, handlers, tokens };
}

describe("token route helpers", () => {
  it("normalizes token creation defaults and expiry", () => {
    assert.deepEqual(tokenCreateInput({}, Date.parse("2026-06-30T00:00:00.000Z")), {
      name: "access token",
      scopes: ["api", "mcp"],
      expiresAt: null
    });
    assert.deepEqual(tokenCreateInput({
      name: "runner",
      scopes: ["runner"],
      expiresInDays: 2
    }, Date.parse("2026-06-30T00:00:00.000Z")), {
      name: "runner",
      scopes: ["runner"],
      expiresAt: "2026-07-02T00:00:00.000Z"
    });
  });

  it("rejects unknown scopes so typos never become long-lived credentials", () => {
    const input = tokenCreateInput({ name: "oops", scopes: ["api", "reed"] });
    assert.equal(input.error.status, 400);
    assert.deepEqual(input.error.body.unknown, ["reed"]);
    assert.deepEqual(input.error.body.known, KNOWN_TOKEN_SCOPES);

    // Every documented scope is mintable, including approvals and read
    // (least-privilege bots and read-only monitors).
    for (const scope of KNOWN_TOKEN_SCOPES) {
      assert.equal(tokenCreateInput({ scopes: [scope] }).error, undefined, scope);
    }
  });

  it("keeps the scope metadata, presets, and defaults inside the known vocabulary", () => {
    assert.deepEqual(
      TOKEN_SCOPE_METADATA.map((entry) => entry.scope).sort(),
      [...KNOWN_TOKEN_SCOPES].sort(),
      "every known scope is described exactly once"
    );
    for (const entry of TOKEN_SCOPE_METADATA) {
      assert.ok(entry.title.length > 1 && entry.summary.length > 20, `${entry.scope} needs a title and summary`);
    }
    for (const preset of TOKEN_PRESETS) {
      for (const scope of preset.scopes) {
        assert.ok(KNOWN_TOKEN_SCOPES.includes(scope), `preset ${preset.id} uses unknown scope ${scope}`);
      }
      assert.ok(preset.summary.length > 20, `preset ${preset.id} needs a summary`);
    }
    const defaults = TOKEN_PRESETS.filter((preset) => preset.default);
    assert.equal(defaults.length, 1, "exactly one default preset");
    assert.equal(defaults[0].id, "everything");
    const readOnly = TOKEN_PRESETS.find((preset) => preset.id === "read-only");
    assert.deepEqual(readOnly.scopes, ["read"], "read-only preset mints a read-scope token");
    for (const scope of DEFAULT_TOKEN_SCOPES) {
      assert.ok(KNOWN_TOKEN_SCOPES.includes(scope));
    }
  });

  it("serves the scope vocabulary through the route handler", () => {
    const { handlers } = harness();
    const res = response();
    handlers.listTokenScopes(req(), res);
    assert.deepEqual(res.body.scopes, TOKEN_SCOPE_METADATA);
    assert.deepEqual(res.body.presets, TOKEN_PRESETS);
    assert.deepEqual(res.body.defaultScopes, DEFAULT_TOKEN_SCOPES);
    assert.deepEqual(res.body.known, KNOWN_TOKEN_SCOPES);
  });

  it("400s through the route handler on unknown scopes without minting", () => {
    const { audits, handlers, tokens } = harness();
    const res = response();
    handlers.createToken(req({ body: { name: "evil", scopes: ["superuser"] } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "unknown scopes");
    assert.equal(tokens.length, 2, "no token minted");
    assert.equal(audits.length, 0, "no audit entry for a rejected mint");
  });

  it("blocks revoking the last active admin token", () => {
    assert.deepEqual(revokeTokenDecision([
      { id: "admin", active: true, scopes: ["admin"] },
      { id: "api", active: true, scopes: ["api"] }
    ], "admin"), {
      ok: false,
      status: 409,
      body: { error: "cannot revoke the last active admin token" }
    });
  });

  it("allows revoking non-last admins and non-admin tokens", () => {
    assert.equal(revokeTokenDecision([
      { id: "admin1", active: true, scopes: ["admin"] },
      { id: "admin2", active: true, scopes: ["admin"] }
    ], "admin1").ok, true);
    assert.equal(revokeTokenDecision([
      { id: "admin1", active: true, scopes: ["admin"] },
      { id: "api", active: true, scopes: ["api"] }
    ], "api").ok, true);
  });

  it("reports missing tokens", () => {
    assert.deepEqual(revokeTokenDecision([], "missing"), {
      ok: false,
      status: 404,
      body: { error: "token not found" }
    });
  });

  it("lists and creates tokens through route handlers", () => {
    const { audits, handlers } = harness();

    const listRes = response();
    handlers.listTokens(req(), listRes);
    assert.equal(listRes.body.tokens.length, 2);

    const createRes = response();
    handlers.createToken(req({
      body: { name: "runner", scopes: ["runner"], expiresInDays: 1 },
      token: { id: "tok_admin" }
    }), createRes);
    assert.equal(createRes.body.token.name, "runner");
    assert.deepEqual(createRes.body.token.scopes, ["runner"]);
    assert.ok(createRes.body.token.expiresAt);
    assert.deepEqual(audits[0], {
      actor: "tok_admin",
      action: "token.created",
      target: "tok_3",
      detail: { scopes: ["runner"], expiresAt: createRes.body.token.expiresAt }
    });
  });

  it("revokes tokens through route handlers and preserves last-admin guard", () => {
    const { audits, handlers, tokens } = harness();

    const apiRes = response();
    handlers.revokeToken(req({ params: { id: "api" } }), apiRes);
    assert.equal(apiRes.body.token.active, false);
    assert.equal(audits[0].action, "token.revoked");

    const adminRes = response();
    handlers.revokeToken(req({ params: { id: "admin" } }), adminRes);
    assert.equal(adminRes.statusCode, 409);
    assert.equal(tokens.find((entry) => entry.id === "admin").active, true);

    const missingRes = response();
    handlers.revokeToken(req({ params: { id: "missing" } }), missingRes);
    assert.equal(missingRes.statusCode, 404);
  });
});
