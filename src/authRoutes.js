import { sign } from "./security.js";
import { TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS } from "./telegramWebAppAuth.js";

export const ACCESS_TOKEN_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365;

export function setupPayload({
  dataDir,
  environment,
  hostname,
  instanceName,
  baseUrl,
  telegramApprovalChatId,
  telegramApprovalTarget,
  telegramBotToken,
  telegramWebhookSecret
} = {}) {
  const telegramTarget = telegramApprovalTarget();
  return {
    instanceName,
    environment,
    hostname,
    baseUrl,
    auth: "access-token",
    telegramConfigured: Boolean(telegramBotToken && telegramTarget),
    telegramApprovalPrivateConfigured: Boolean(telegramApprovalChatId),
    telegramApprovalTarget: telegramTarget ? (telegramTarget.private ? "private" : "fallback-chat") : "none",
    telegramWebhookSecured: Boolean(telegramWebhookSecret),
    dataDir
  };
}

export function sessionCookieOptions({ baseUrl, maxAge } = {}) {
  return {
    httpOnly: true,
    secure: String(baseUrl || "").startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge
  };
}

export function publicToken(token) {
  return { id: token.id, name: token.name, scopes: token.scopes };
}

export function createAuthHandlers({
  authenticateToken,
  baseUrl,
  createTelegramWebAppSession,
  env,
  recordAudit,
  telegramApprovalTarget,
  telegramUserLabel,
  timingSafeEqualStr,
  verifyTelegramWebAppInitData
} = {}) {
  function sendSessionValue(res, value, maxAge) {
    res.cookie("shub_session", sign(value), sessionCookieOptions({ baseUrl, maxAge }));
  }

  return {
    setup(_req, res) {
      res.json(setupPayload({ ...env, telegramApprovalTarget }));
    },

    tokenLogin(req, res) {
      const token = req.body.token || "";
      const record = authenticateToken(token);
      if (!record) return res.status(401).json({ error: "invalid token" });
      sendSessionValue(res, token, env.sessionCookieMaxAgeMs || ACCESS_TOKEN_SESSION_MAX_AGE_MS);
      recordAudit(record.name, "auth.login", record.id, {});
      res.json({ ok: true, token: publicToken(record) });
    },

    telegramWebAppLogin(req, res) {
      const verified = verifyTelegramWebAppInitData(req.body.initData || "", {
        botToken: env.telegramBotToken,
        approvalUserIds: env.telegramApprovalUserIds,
        approvalChatId: env.telegramApprovalChatId,
        timingSafeEqualStr
      });
      if (!verified.ok) return res.status(verified.code).json({ error: verified.error });
      const sessionValue = createTelegramWebAppSession(verified.user);
      const actor = telegramUserLabel(verified.user);
      sendSessionValue(res, sessionValue, TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS);
      recordAudit(actor, "auth.telegram_webapp", String(verified.user.id), { authDate: verified.authDate });
      res.json({
        ok: true,
        token: {
          id: `telegram-webapp:${verified.user.id}`,
          name: actor,
          scopes: ["approvals"]
        }
      });
    },

    logout(_req, res) {
      res.clearCookie("shub_session", { path: "/" });
      res.json({ ok: true });
    },

    me(req, res) {
      res.json({ token: publicToken(req.token) });
    }
  };
}
