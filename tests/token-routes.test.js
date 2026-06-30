import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  revokeTokenDecision,
  tokenCreateInput
} from "../src/tokenRoutes.js";

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
});
