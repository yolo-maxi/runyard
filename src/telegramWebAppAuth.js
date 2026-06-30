import { createHmac } from "node:crypto";

export const TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24;
export const TELEGRAM_WEBAPP_AUTH_MAX_AGE_SECONDS = 10 * 60;
export const TELEGRAM_WEBAPP_AUTH_FUTURE_SKEW_SECONDS = 60;
const TELEGRAM_WEBAPP_SESSION_PREFIX = "telegram-webapp:";

export function csvValues(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function telegramApprovalUserAllowlist({ approvalUserIds = "", approvalChatId = "" } = {}) {
  return new Set(csvValues(approvalUserIds || approvalChatId).map(String));
}

export function telegramUserLabel(user) {
  const handle = user?.username || [user?.first_name, user?.last_name].filter(Boolean).join(" ");
  return `telegram:${handle || user?.id || "user"}`;
}

export function parseTelegramUser(raw) {
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    if (user && user.id != null) return user;
  } catch {
    return null;
  }
  return null;
}

export function verifyTelegramWebAppInitData(initData, options = {}) {
  const {
    botToken = "",
    approvalUserIds = "",
    approvalChatId = "",
    timingSafeEqualStr,
    nowMs = Date.now()
  } = options;
  if (!botToken) return { ok: false, code: 503, error: "telegram webapp auth not configured" };
  if (typeof initData !== "string" || !initData.trim() || initData.length > 8192) {
    return { ok: false, code: 400, error: "missing telegram init data" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!/^[a-f0-9]{64}$/i.test(hash)) return { ok: false, code: 401, error: "invalid telegram signature" };

  const dataCheckString = telegramDataCheckString(params);
  if (!dataCheckString) return { ok: false, code: 401, error: "invalid telegram signature" };

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const equal = timingSafeEqualStr || ((left, right) => left === right);
  if (!equal(hash.toLowerCase(), expectedHash)) {
    return { ok: false, code: 401, error: "invalid telegram signature" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || authDate > nowSeconds + TELEGRAM_WEBAPP_AUTH_FUTURE_SKEW_SECONDS) {
    return { ok: false, code: 401, error: "invalid telegram auth date" };
  }
  if (nowSeconds - authDate > TELEGRAM_WEBAPP_AUTH_MAX_AGE_SECONDS) {
    return { ok: false, code: 401, error: "telegram auth expired" };
  }

  const user = parseTelegramUser(params.get("user"));
  if (!user) return { ok: false, code: 401, error: "telegram user missing" };
  const allowlist = telegramApprovalUserAllowlist({ approvalUserIds, approvalChatId });
  if (!allowlist.size) return { ok: false, code: 503, error: "telegram approval operator not configured" };
  if (!allowlist.has(String(user.id))) return { ok: false, code: 403, error: "telegram user is not authorized" };

  return { ok: true, authDate, user };
}

export function createTelegramWebAppSession(user, { nowMs = Date.now(), maxAgeMs = TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS } = {}) {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = {
    type: "telegram-webapp",
    uid: String(user.id),
    name: telegramUserLabel(user),
    scopes: ["approvals"],
    iat: issuedAt,
    exp: issuedAt + Math.floor(maxAgeMs / 1000)
  };
  return `${TELEGRAM_WEBAPP_SESSION_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

export function authenticateTelegramWebAppSession(value, options = {}) {
  const { approvalUserIds = "", approvalChatId = "", nowMs = Date.now() } = options;
  if (!String(value || "").startsWith(TELEGRAM_WEBAPP_SESSION_PREFIX)) return null;
  try {
    const encoded = String(value).slice(TELEGRAM_WEBAPP_SESSION_PREFIX.length);
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload?.type !== "telegram-webapp" || !payload.uid || !Array.isArray(payload.scopes)) return null;
    if (Number(payload.exp || 0) <= Math.floor(nowMs / 1000)) return null;
    if (!telegramApprovalUserAllowlist({ approvalUserIds, approvalChatId }).has(String(payload.uid))) return null;
    return {
      id: `telegram-webapp:${payload.uid}`,
      name: payload.name || `telegram:${payload.uid}`,
      scopes: payload.scopes,
      authMethod: "telegram-webapp",
      telegramUserId: String(payload.uid)
    };
  } catch {
    return null;
  }
}

export function telegramSessionCanAccess(req) {
  if (req.method === "GET" && req.path === "/api/me") return true;
  if (req.method === "GET" && /^\/api\/approvals(?:\/[^/]+)?\/?$/.test(req.path)) return true;
  if (req.method === "POST" && /^\/api\/approvals\/[^/]+\/(?:approve|reject|request-changes)\/?$/.test(req.path)) return true;
  if (req.method === "GET" && /^\/api\/runs(?:\/[^/]+(?:\/(?:events|logs|artifacts))?)?\/?$/.test(req.path)) return true;
  if (req.method === "GET" && /^\/api\/artifacts\/[^/]+\/download\/?$/.test(req.path)) return true;
  return false;
}

function telegramDataCheckString(params) {
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") pairs.push([key, value]);
  }
  if (!pairs.length) return "";
  pairs.sort(([a], [b]) => a.localeCompare(b));
  return pairs.map(([key, value]) => `${key}=${value}`).join("\n");
}
