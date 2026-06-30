import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS,
  authenticateTelegramWebAppSession,
  createTelegramWebAppSession,
  parseTelegramUser,
  telegramSessionCanAccess,
  telegramUserLabel,
  verifyTelegramWebAppInitData
} from "../src/telegramWebAppAuth.js";
import { timingSafeEqualStr } from "../src/security.js";

const botToken = "123456:TESTTOKEN";
const nowMs = Date.UTC(2026, 0, 1, 0, 10, 0);
const authDate = Math.floor(nowMs / 1000);
const user = { id: 42, username: "operator", first_name: "Op" };

describe("Telegram WebApp auth helpers", () => {
  it("verifies signed init data for an allowlisted operator", () => {
    const initData = signedInitData({ auth_date: String(authDate), query_id: "abc", user: JSON.stringify(user) });
    const result = verifyTelegramWebAppInitData(initData, {
      botToken,
      approvalUserIds: "42",
      timingSafeEqualStr,
      nowMs
    });
    assert.equal(result.ok, true);
    assert.equal(result.authDate, authDate);
    assert.deepEqual(result.user, user);
  });

  it("rejects bad signatures, stale auth dates, and non-allowlisted users", () => {
    const valid = signedInitData({ auth_date: String(authDate), user: JSON.stringify(user) });
    assert.equal(verifyTelegramWebAppInitData(`${valid.slice(0, -1)}0`, { botToken, approvalUserIds: "42", timingSafeEqualStr, nowMs }).error, "invalid telegram signature");
    assert.equal(verifyTelegramWebAppInitData(signedInitData({ auth_date: String(authDate - 999), user: JSON.stringify(user) }), { botToken, approvalUserIds: "42", timingSafeEqualStr, nowMs }).error, "telegram auth expired");
    assert.equal(verifyTelegramWebAppInitData(valid, { botToken, approvalUserIds: "7", timingSafeEqualStr, nowMs }).error, "telegram user is not authorized");
  });

  it("creates and authenticates bounded approval sessions", () => {
    const session = createTelegramWebAppSession(user, { nowMs });
    const token = authenticateTelegramWebAppSession(session, { approvalUserIds: "42", nowMs: nowMs + 1000 });
    assert.equal(token.id, "telegram-webapp:42");
    assert.equal(token.name, "telegram:operator");
    assert.deepEqual(token.scopes, ["approvals"]);
    assert.equal(authenticateTelegramWebAppSession(session, { approvalUserIds: "42", nowMs: nowMs + TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS + 1000 }), null);
    assert.equal(authenticateTelegramWebAppSession(session, { approvalUserIds: "7", nowMs }), null);
  });

  it("parses users, labels users, and limits Telegram session route access", () => {
    assert.deepEqual(parseTelegramUser(JSON.stringify(user)), user);
    assert.equal(parseTelegramUser("{bad"), null);
    assert.equal(telegramUserLabel({ id: 5, first_name: "Ada", last_name: "Lovelace" }), "telegram:Ada Lovelace");
    assert.equal(telegramSessionCanAccess({ method: "GET", path: "/api/approvals/appr_123" }), true);
    assert.equal(telegramSessionCanAccess({ method: "POST", path: "/api/runs/run_123/cancel" }), false);
  });
});

function signedInitData(fields) {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams([...entries, ["hash", hash]]).toString();
}
