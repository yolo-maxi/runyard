export function tokenCreateInput(body = {}, nowMs = Date.now()) {
  const scopes = Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ["api", "mcp"];
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
