import { parseCookies, unsign } from "./security.js";

export function createAuthMiddleware({
  authenticateTelegramWebAppSession,
  authenticateToken,
  env,
  getRun,
  runOwnerTokenId,
  telegramSessionCanAccess
} = {}) {
  function authenticateSessionValue(value) {
    return authenticateTelegramWebAppSession(value, {
      approvalUserIds: env.telegramApprovalUserIds,
      approvalChatId: env.telegramApprovalChatId
    }) || authenticateToken(value);
  }

  function authFromRequest(req) {
    const header = headerString(req?.headers?.authorization);
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
    const cookies = parseCookies(req);
    const cookieToken = cookies.shub_session ? unsign(cookies.shub_session) : "";
    return bearer ? authenticateToken(bearer) : authenticateSessionValue(cookieToken);
  }

  function requireAuth(req, res, next) {
    const token = authFromRequest(req);
    if (!token) return res.status(401).json({ error: "unauthorized" });
    req.token = token;
    if (token.authMethod === "telegram-webapp" && !telegramSessionCanAccess(req)) {
      return res.status(403).json({ error: "telegram session cannot access this endpoint" });
    }
    next();
  }

  // Scope enforcement. `admin` is a superscope that satisfies every requirement.
  function requireScopes(...needed) {
    return (req, res, next) => {
      const scopes = req.token?.scopes || [];
      if (scopes.includes("admin") || needed.some((scope) => scopes.includes(scope))) return next();
      return res.status(403).json({ error: "insufficient scope", required: needed });
    };
  }

  // Restrict a run's lifecycle endpoints to the runner that owns it (or any admin token).
  function requireRunOwnerOrAdmin(req, res, next) {
    const scopes = req.token?.scopes || [];
    if (scopes.includes("admin")) return next();
    if (!getRun(req.params.id)) return res.status(404).json({ error: "run not found" });
    if (runOwnerTokenId(req.params.id) === req.token.id) return next();
    return res.status(403).json({ error: "run not owned by this runner" });
  }

  function requireRunOwnerIfRunner(req, res, next) {
    const scopes = req.token?.scopes || [];
    if (scopes.includes("admin") || !scopes.includes("runner")) return next();
    if (!getRun(req.params.id)) return res.status(404).json({ error: "run not found" });
    if (runOwnerTokenId(req.params.id) === req.token.id) return next();
    return res.status(403).json({ error: "run not owned by this runner" });
  }

  return {
    authFromRequest,
    requireAuth,
    requireRunOwnerIfRunner,
    requireRunOwnerOrAdmin,
    requireScopes
  };
}

function headerString(value) {
  return typeof value === "string" ? value : "";
}
