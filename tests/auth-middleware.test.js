import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthMiddleware } from "../src/authMiddleware.js";
import { sign } from "../src/security.js";
import { mockResponse as response } from "./response.js";

function runMiddleware(middleware, req) {
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

function auth(overrides = {}) {
  return createAuthMiddleware({
    authenticateTelegramWebAppSession: (value) => value === "tg-session"
      ? { id: "telegram-webapp:1", name: "telegram:1", scopes: ["approvals"], authMethod: "telegram-webapp" }
      : null,
    authenticateToken: (value) => value === "admin-token"
      ? { id: "tok_admin", name: "Admin", scopes: ["admin"] }
      : value === "runner-token"
        ? { id: "tok_runner", name: "Runner", scopes: ["runner"] }
        : null,
    env: {
      telegramApprovalChatId: "1",
      telegramApprovalUserIds: "1"
    },
    getRun: (id) => id === "run_1" ? { id } : null,
    runOwnerTokenId: () => "tok_runner",
    telegramSessionCanAccess: (req) => req.path === "/api/me",
    ...overrides
  });
}

describe("auth middleware helpers", () => {
  it("authenticates bearer tokens before cookies", () => {
    const middleware = auth();
    const req = {
      headers: {
        authorization: "Bearer admin-token",
        cookie: `shub_session=${encodeURIComponent(sign("runner-token"))}`
      }
    };

    assert.equal(middleware.authFromRequest(req).id, "tok_admin");
  });

  it("authenticates signed session cookies", () => {
    const middleware = auth();
    const req = {
      headers: {
        cookie: `shub_session=${encodeURIComponent(sign("runner-token"))}`
      }
    };

    assert.equal(middleware.authFromRequest(req).id, "tok_runner");
  });

  it("requires authentication and enforces Telegram session route access", () => {
    const middleware = auth();
    const missing = runMiddleware(middleware.requireAuth, { headers: {} });
    assert.equal(missing.res.statusCode, 401);
    assert.deepEqual(missing.res.body, { error: "unauthorized" });

    const allowed = runMiddleware(middleware.requireAuth, {
      path: "/api/me",
      headers: { cookie: `shub_session=${encodeURIComponent(sign("tg-session"))}` }
    });
    assert.equal(allowed.nextCalled, true);

    const blocked = runMiddleware(middleware.requireAuth, {
      path: "/api/tokens",
      headers: { cookie: `shub_session=${encodeURIComponent(sign("tg-session"))}` }
    });
    assert.equal(blocked.res.statusCode, 403);
    assert.deepEqual(blocked.res.body, { error: "telegram session cannot access this endpoint" });
  });

  it("enforces scopes with admin as a superscope", () => {
    const middleware = auth();
    assert.equal(runMiddleware(middleware.requireScopes("api"), { token: { scopes: ["admin"] } }).nextCalled, true);
    assert.equal(runMiddleware(middleware.requireScopes("runner"), { token: { scopes: ["runner"] } }).nextCalled, true);

    const denied = runMiddleware(middleware.requireScopes("admin"), { token: { scopes: ["api"] } });
    assert.equal(denied.res.statusCode, 403);
    assert.deepEqual(denied.res.body, { error: "insufficient scope", required: ["admin"] });
  });

  it("restricts runner-owned run routes to the owning runner or an admin", () => {
    const middleware = auth();
    assert.equal(runMiddleware(middleware.requireRunOwnerOrAdmin, {
      params: { id: "run_1" },
      token: { id: "tok_admin", scopes: ["admin"] }
    }).nextCalled, true);
    assert.equal(runMiddleware(middleware.requireRunOwnerOrAdmin, {
      params: { id: "run_1" },
      token: { id: "tok_runner", scopes: ["runner"] }
    }).nextCalled, true);

    const missing = runMiddleware(middleware.requireRunOwnerOrAdmin, {
      params: { id: "missing" },
      token: { id: "tok_runner", scopes: ["runner"] }
    });
    assert.equal(missing.res.statusCode, 404);

    const forbidden = runMiddleware(middleware.requireRunOwnerOrAdmin, {
      params: { id: "run_1" },
      token: { id: "someone_else", scopes: ["runner"] }
    });
    assert.equal(forbidden.res.statusCode, 403);
    assert.deepEqual(forbidden.res.body, { error: "run not owned by this runner" });
  });
});
