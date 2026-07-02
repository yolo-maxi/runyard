import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthHandlers, sessionCookieOptions, setupPayload } from "../src/authRoutes.js";
import { unsign } from "../src/security.js";

function response() {
  return {
    body: null,
    cookies: [],
    statusCode: 200,
    cleared: [],
    clearCookie(name, options) {
      this.cleared.push({ name, options });
      return this;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    }
  };
}

function authHandlers(overrides = {}) {
  return createAuthHandlers({
    authenticateToken: (token) => token === "good" ? { id: "tok_1", name: "Admin", scopes: ["admin"] } : null,
    baseUrl: "https://hub.example",
    createTelegramWebAppSession: (user) => `tg-session-${user.id}`,
    env: {
      baseUrl: "https://hub.example",
      dataDir: "/tmp/runyard",
      environment: "test",
      hostname: "host",
      instanceName: "Runyard",
      sessionCookieMaxAgeMs: 1234,
      telegramApprovalChatId: "42",
      telegramApprovalUserIds: "42",
      telegramBotToken: "bot-token",
      telegramWebhookSecret: "webhook-secret"
    },
    recordAudit: () => {},
    telegramApprovalTarget: () => ({ private: true }),
    telegramUserLabel: (user) => `telegram:${user.username || user.id}`,
    timingSafeEqualStr: (left, right) => left === right,
    verifyTelegramWebAppInitData: () => ({
      ok: true,
      authDate: 123,
      user: { id: 42, username: "operator" }
    }),
    ...overrides
  });
}

describe("auth route helpers", () => {
  it("builds setup payload without leaking secrets", () => {
    assert.deepEqual(setupPayload({
      baseUrl: "https://hub.example",
      dataDir: "/data",
      environment: "prod",
      hostname: "host",
      instanceName: "Runyard",
      telegramApprovalChatId: "42",
      telegramApprovalTarget: () => ({ private: false }),
      telegramBotToken: "secret-token",
      telegramWebhookSecret: "secret-webhook"
    }), {
      instanceName: "Runyard",
      environment: "prod",
      hostname: "host",
      baseUrl: "https://hub.example",
      auth: "access-token",
      telegramConfigured: true,
      telegramApprovalPrivateConfigured: true,
      telegramApprovalTarget: "fallback-chat",
      telegramWebhookSecured: true
    });
  });

  it("sets secure session cookie options for https hubs", () => {
    assert.deepEqual(sessionCookieOptions({ baseUrl: "https://hub.example", maxAge: 123 }), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 123
    });
  });

  it("logs in access tokens and records audit metadata", () => {
    const audits = [];
    const handlers = authHandlers({
      recordAudit: (...entry) => audits.push(entry)
    });
    const res = response();

    handlers.tokenLogin({ body: { token: "good" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(unsign(res.cookies[0].value), "good");
    assert.equal(res.cookies[0].options.maxAge, 1234);
    assert.deepEqual(audits[0], ["Admin", "auth.login", "tok_1", {}]);
    assert.deepEqual(res.body, { ok: true, token: { id: "tok_1", name: "Admin", scopes: ["admin"] } });
  });

  it("rejects invalid access tokens", () => {
    const res = response();

    authHandlers().tokenLogin({ body: { token: "bad" } }, res);

    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "invalid token" });
  });

  it("logs in Telegram WebApp operators with an approval-scoped session", () => {
    const audits = [];
    const res = response();

    authHandlers({ recordAudit: (...entry) => audits.push(entry) })
      .telegramWebAppLogin({ body: { initData: "signed-init-data" } }, res);

    assert.equal(unsign(res.cookies[0].value), "tg-session-42");
    assert.equal(res.body.token.id, "telegram-webapp:42");
    assert.deepEqual(res.body.token.scopes, ["approvals"]);
    assert.deepEqual(audits[0], ["telegram:operator", "auth.telegram_webapp", "42", { authDate: 123 }]);
  });

  it("clears the session cookie on logout and echoes the current token on me", () => {
    const handlers = authHandlers();
    const logoutRes = response();
    const meRes = response();

    handlers.logout({}, logoutRes);
    handlers.me({ token: { id: "tok_1", name: "Admin", scopes: ["admin"] } }, meRes);

    assert.deepEqual(logoutRes.cleared, [{ name: "shub_session", options: { path: "/" } }]);
    assert.deepEqual(logoutRes.body, { ok: true });
    assert.deepEqual(meRes.body, { token: { id: "tok_1", name: "Admin", scopes: ["admin"] } });
  });
});
