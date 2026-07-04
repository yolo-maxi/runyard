import { actorName } from "./routeActors.js";

// The full scope vocabulary the server enforces (see authMiddleware/serverRoutes).
// Token creation validates against this list so a typo'd or invented scope can
// never be minted into a long-lived credential.
export const KNOWN_TOKEN_SCOPES = ["api", "mcp", "runner", "admin", "approvals"];

export function tokenCreateInput(body = {}, nowMs = Date.now()) {
  const scopes = Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ["api", "mcp"];
  const unknown = scopes.filter((scope) => !KNOWN_TOKEN_SCOPES.includes(scope));
  if (unknown.length) {
    return { error: { status: 400, body: { error: "unknown scopes", unknown, known: KNOWN_TOKEN_SCOPES } } };
  }
  const days = Number(body.expiresInDays || 0);
  return {
    name: body.name || "access token",
    scopes,
    expiresAt: days > 0 ? new Date(nowMs + days * 86_400_000).toISOString() : null
  };
}

export function revokeTokenDecision(tokens = [], targetId) {
  const target = tokens.find((entry) => entry.id === targetId);
  if (!target) return { ok: false, status: 404, body: { error: "token not found" } };
  const activeAdmins = tokens.filter((entry) => entry.active && entry.scopes.includes("admin"));
  if (target.active && target.scopes.includes("admin") && activeAdmins.length <= 1) {
    return { ok: false, status: 409, body: { error: "cannot revoke the last active admin token" } };
  }
  return { ok: true, target };
}

export function createTokenHandlers({
  createAccessToken,
  listAccessTokens,
  recordAudit,
  revokeAccessToken
} = {}) {
  return {
    listTokens(_req, res) {
      res.json({ tokens: listAccessTokens() });
    },

    createToken(req, res) {
      const input = tokenCreateInput(req.body || {});
      if (input.error) return res.status(input.error.status).json(input.error.body);
      const token = createAccessToken(input.name, undefined, input.scopes, { expiresAt: input.expiresAt });
      recordAudit(actorName(req.token), "token.created", token.id, {
        scopes: input.scopes,
        expiresAt: input.expiresAt
      });
      res.json({ token });
    },

    revokeToken(req, res) {
      const decision = revokeTokenDecision(listAccessTokens(), req.params.id);
      if (!decision.ok) return res.status(decision.status).json(decision.body);
      const revoked = revokeAccessToken(req.params.id);
      recordAudit(actorName(req.token), "token.revoked", req.params.id, {});
      res.json({ token: revoked });
    }
  };
}
