import { actorName } from "./routeActors.js";

// The full scope vocabulary the server enforces (see authMiddleware/serverRoutes).
// Token creation validates against this list so a typo'd or invented scope can
// never be minted into a long-lived credential.
export const KNOWN_TOKEN_SCOPES = ["api", "mcp", "runner", "admin", "approvals", "read"];

export const DEFAULT_TOKEN_SCOPES = ["api", "mcp"];

// Honest per-scope descriptions for UI/API/MCP consumers. Two facts shape the
// wording: every authenticated token can READ non-admin state (reads require
// auth, not a scope), and mutation endpoints accept ANY listed scope — so
// `api`, `mcp`, and `approvals` all satisfy the approval-decision endpoints.
// The `read` scope is the exception that proves the model: it satisfies no
// mutation requirement, so a read-only token can inspect but never change.
// `groups` names the API groups (src/apiSurface.js API_GROUPS) the scope can
// WRITE to; reads span all non-admin groups for every scope.
export const TOKEN_SCOPE_METADATA = [
  {
    scope: "api",
    title: "API",
    summary: "Full HTTP/CLI client power: run, preflight, rerun, cancel, and promote runs; manage run drafts; create and decide approvals. No admin or runner rights.",
    groups: ["workflows", "runs", "approvals"]
  },
  {
    scope: "mcp",
    title: "MCP",
    summary: "Same power as api, conventionally issued to MCP/agent clients. Endpoints that accept api also accept mcp.",
    groups: ["workflows", "runs", "approvals"]
  },
  {
    scope: "approvals",
    title: "Approvals",
    summary: "Create approval cards and decide them (approve, reject, request changes). Cannot start, cancel, or control runs.",
    groups: ["approvals"]
  },
  {
    scope: "read",
    title: "Read-only",
    summary: "Inspect state only: workflows, runs, logs, artifacts, approvals, schedules, runners, dashboard, and the menu. Satisfies no create/update/delete/run/cancel/approve endpoint.",
    groups: []
  },
  {
    scope: "runner",
    title: "Runner",
    summary: "Runner machine protocol only: register, heartbeat, claim runs, and report lifecycle events and artifacts. For runner processes, not people.",
    groups: ["runs"]
  },
  {
    scope: "admin",
    title: "Admin",
    summary: "Superscope: satisfies every scope requirement and unlocks admin-only surfaces — tokens, secrets, audit, alerts, updates, and workflow/schedule/library management.",
    groups: ["workflows", "runs", "approvals", "automation", "library", "distribution", "admin", "system"]
  }
];

// Named scope bundles for issuing tokens. The UI defaults to `everything`;
// `read-only` is the safe hand-out for dashboards and monitors. Finer-grained
// per-group write scopes (workflow-operator vs automation-manager vs
// library-manager) need per-operation enforcement changes and are a
// documented follow-up, not a preset that would overpromise today.
export const TOKEN_PRESETS = [
  {
    id: "everything",
    title: "Everything",
    scopes: ["api", "mcp", "approvals"],
    default: true,
    summary: "Normal full-power token for a person or agent: read everything, run workflows, manage drafts and schedules-run-now, decide approvals. No admin or runner rights."
  },
  {
    id: "read-only",
    title: "Read-only",
    scopes: ["read"],
    summary: "Inspect the deployment without being able to change it — workflows, runs, logs, artifacts, approvals, schedules, runners. Good for dashboards, monitors, and cautious integrations."
  },
  {
    id: "approvals-only",
    title: "Approvals only",
    scopes: ["approvals"],
    summary: "Approval inbox and decisions only; cannot start or control runs. What Telegram approval sessions use."
  },
  {
    id: "runner",
    title: "Runner",
    scopes: ["runner"],
    summary: "For runner machines: the runner protocol and nothing else. Keep separate from human tokens."
  },
  {
    id: "admin",
    title: "Admin",
    scopes: ["admin"],
    summary: "Full control, including tokens, secrets, audit, and updates. Issue sparingly."
  }
];

export function tokenCreateInput(body = {}, nowMs = Date.now()) {
  const scopes = Array.isArray(body.scopes) && body.scopes.length ? body.scopes : [...DEFAULT_TOKEN_SCOPES];
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

    listTokenScopes(_req, res) {
      res.json({
        scopes: TOKEN_SCOPE_METADATA,
        presets: TOKEN_PRESETS,
        defaultScopes: DEFAULT_TOKEN_SCOPES,
        known: KNOWN_TOKEN_SCOPES
      });
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
