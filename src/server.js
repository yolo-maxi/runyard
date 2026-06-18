import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import express from "express";
import {
  addRunEvent,
  authenticateToken,
  createAccessToken,
  createArtifact,
  createRun,
  dashboardStats,
  getArtifact,
  getCapability,
  countRuns,
  getRun,
  heartbeatRunner,
  listAccessTokens,
  listAgents,
  listApprovals,
  listAudit,
  listArtifacts,
  listCapabilities,
  listKnowledge,
  listRunEvents,
  listRunners,
  listRuns,
  listSkills,
  reapStuckRuns,
  recordAudit,
  registerRunner,
  resolveApproval,
  revokeAccessToken,
  runOwnerTokenId,
  transitionRun,
  upsertAgent,
  upsertCapability,
  upsertKnowledge,
  upsertSkill,
  updateRun
} from "./db.js";
import { env } from "./env.js";
import { now, slugify } from "./ids.js";
import { parseCookies, sign, timingSafeEqualStr, unsign } from "./security.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", env.trustProxy);

// Modest global body limit; artifact uploads (which carry base64 file content) get a larger one.
const ARTIFACT_BODY_LIMIT = "25mb";
const globalJson = express.json({ limit: "1mb" });
const artifactJson = express.json({ limit: ARTIFACT_BODY_LIMIT });
const isArtifactUpload = (req) => req.method === "POST" && /^\/api\/runs\/[^/]+\/artifacts\/?$/.test(req.path);
app.use((req, res, next) => (isArtifactUpload(req) ? artifactJson : globalJson)(req, res, next));
app.use(express.urlencoded({ extended: false }));

const startedAt = Date.now();

function publicUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function authFromRequest(req) {
  const header = req.headers.authorization || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  const cookies = parseCookies(req);
  const cookieToken = cookies.shub_session ? unsign(cookies.shub_session) : "";
  return authenticateToken(bearer || cookieToken);
}

function requireAuth(req, res, next) {
  const token = authFromRequest(req);
  if (!token) return res.status(401).json({ error: "unauthorized" });
  req.token = token;
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

function sendSession(res, token) {
  res.cookie("shub_session", sign(token), {
    httpOnly: true,
    secure: env.baseUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 365
  });
}

function requireBodySlug(body, fallback) {
  return body.slug || slugify(body.name || body.title || fallback);
}

// Minimal in-memory fixed-window rate limiter keyed by client + bucket.
const rateBuckets = new Map();
function rateLimit({ bucket, max, windowMs }) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const nowMs = Date.now();
    const entry = rateBuckets.get(key);
    if (!entry || nowMs > entry.reset) {
      rateBuckets.set(key, { count: 1, reset: nowMs + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.setHeader("retry-after", Math.ceil((entry.reset - nowMs) / 1000));
      return res.status(429).json({ error: "too many requests" });
    }
    entry.count += 1;
    next();
  };
}

// Periodically evict expired buckets so distinct client IPs can't leak memory.
const rateSweep = setInterval(() => {
  const nowMs = Date.now();
  for (const [key, entry] of rateBuckets) if (nowMs > entry.reset) rateBuckets.delete(key);
}, 60_000);
rateSweep.unref?.();

// Restrict a run's lifecycle endpoints to the runner that owns it (or any admin token).
function requireRunOwnerOrAdmin(req, res, next) {
  const scopes = req.token?.scopes || [];
  if (scopes.includes("admin")) return next();
  if (!getRun(req.params.id)) return res.status(404).json({ error: "run not found" });
  if (runOwnerTokenId(req.params.id) === req.token.id) return next();
  return res.status(403).json({ error: "run not owned by this runner" });
}

async function notifyTelegram(approval) {
  if (!env.telegramBotToken || !env.telegramChatId) return;
  const text = [
    `Smithers Hub approval requested`,
    ``,
    `*${approval.title}*`,
    approval.description || "",
    ``,
    `Approval ID: \`${approval.id}\``,
    approval.runId ? `Run: \`${approval.runId}\`` : ""
  ]
    .filter(Boolean)
    .join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.telegramChatId,
        ...(env.telegramThreadId ? { message_thread_id: Number(env.telegramThreadId) } : {}),
        text,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: `approve:${approval.id}` },
              { text: "Reject", callback_data: `reject:${approval.id}` }
            ]
          ]
        }
      })
    });
  } catch (error) {
    console.error("Telegram notification failed:", error.message);
  }
}

app.use((req, res, next) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
  );
  if (env.baseUrl.startsWith("https://")) {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// General API rate limit (defense against scraping/abuse); login has a stricter bucket below.
app.use("/api", rateLimit({ bucket: "api", max: 1200, windowMs: 60_000 }));

app.get("/healthz", (_req, res) => res.json({ status: "ok", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));
app.get("/readyz", (_req, res) => {
  try {
    dashboardStats();
    res.json({ status: "ready" });
  } catch (error) {
    res.status(503).json({ status: "unavailable" });
  }
});
app.get("/api/version", (_req, res) => res.json({ name: "smithers-hub", version: env.version, instanceName: env.instanceName }));

// --- Zero-friction client install -------------------------------------------
// Tarball of the CLI/MCP client (commander is dependency-free, so we vendor it -> no npm needed).
let cliTarballPath = null;
function buildCliTarball() {
  if (cliTarballPath && existsSync(cliTarballPath)) return cliTarballPath;
  const out = path.join(env.dataDir, "cli.tgz");
  const paths = ["bin", "src", "package.json"];
  if (existsSync(path.join(env.root, "workflow-templates"))) paths.push("workflow-templates");
  // -h dereferences symlinks so pnpm's symlinked node_modules/commander is archived as real files.
  if (existsSync(path.join(env.root, "node_modules", "commander"))) paths.push("node_modules/commander");
  execFileSync("tar", ["czhf", out, "-C", env.root, ...paths]);
  cliTarballPath = out;
  return out;
}

app.get("/cli.tgz", (_req, res) => {
  try {
    res.type("application/gzip").sendFile(buildCliTarball());
  } catch (error) {
    res.status(500).json({ error: "could not build client bundle" });
  }
});

// One-line installer: `curl -fsSL <hub>/install.sh | bash` (prefix with SMITHERS_HUB_TOKEN=... to auto-login).
app.get("/install.sh", (req, res) => {
  const hub = publicUrl(req);
  res.type("text/plain").send(`#!/usr/bin/env bash
set -euo pipefail
HUB_URL="\${SMITHERS_HUB_URL:-${hub}}"
APP="$HOME/.smithers-hub/app"
BIN="$HOME/.local/bin"
echo "Installing Smithers Hub client from $HUB_URL ..."
command -v node >/dev/null 2>&1 || { echo "Error: Node.js 18+ is required (https://nodejs.org)."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl is required."; exit 1; }
mkdir -p "$APP" "$BIN"
tmp="$(mktemp)"
curl -fsSL "$HUB_URL/cli.tgz" -o "$tmp"
tar xzf "$tmp" -C "$APP"
rm -f "$tmp"
cat > "$BIN/smithers-hub" <<WRAP
#!/usr/bin/env bash
exec node "$APP/src/cli.js" "\\$@"
WRAP
cat > "$BIN/smithers-hub-mcp" <<WRAP
#!/usr/bin/env bash
exec node "$APP/src/mcp.js" "\\$@"
WRAP
chmod +x "$BIN/smithers-hub" "$BIN/smithers-hub-mcp"
TOKEN="\${SMITHERS_HUB_TOKEN:-}"
REMOTE="\${SMITHERS_HUB_REMOTE:-}"
# Ask for the token + a name for this connection (org) on first run.
if [ -z "$TOKEN" ] && [ -r /dev/tty ]; then
  printf "Paste your Smithers Hub access token (Web Hub -> Connect): " > /dev/tty
  read -r TOKEN < /dev/tty
fi
if [ -z "$REMOTE" ] && [ -r /dev/tty ]; then
  printf "Name this org connection [default]: " > /dev/tty
  read -r REMOTE < /dev/tty
fi
REMOTE="\${REMOTE:-default}"
if [ -n "$TOKEN" ]; then
  node "$APP/src/cli.js" login --remote "$REMOTE" --url "$HUB_URL" --token "$TOKEN" >/dev/null && echo "Logged in to $HUB_URL (remote: $REMOTE)"
else
  echo "No token entered. Log in later with:  smithers-hub login --url $HUB_URL"
fi
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add this to your shell profile:  export PATH=\\"$BIN:\\$PATH\\"" ;;
esac
echo ""
echo "Installed. Next:"
echo "  smithers-hub capabilities      # see what you can run"
echo "  smithers-hub mcp install --all # connect every AI agent on this machine"
`);
});

app.get("/", (_req, res) => res.sendFile(path.join(env.root, "public", "landing.html")));
app.get("/app", (_req, res) => res.sendFile(path.join(env.root, "public", "index.html")));
app.get("/docs", (_req, res) => res.sendFile(path.join(env.root, "public", "docs.html")));
app.use("/public", express.static(path.join(env.root, "public")));

app.get("/llms.txt", (req, res) => {
  res.type("text/plain").send(`# Smithers Hub

Smithers Hub is a self-hosted capability platform for company agents.

Primary agent interface:
- MCP server: smithers-hub-mcp
- HTTP API: ${publicUrl(req)}/api
- Capability catalog: ${publicUrl(req)}/api/capabilities

Core tools:
- list_capabilities
- search_capabilities
- describe_capability
- run_capability
- get_run_status
- get_run_logs
- get_run_artifacts
- list_pending_approvals
- approve_run
- reject_run
- cancel_run
- search_artifacts
- list_agents
- list_skills
- search_knowledge

Authenticate with a Hub access token using Bearer auth.
`);
});

app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: { title: "Smithers Hub API", version: "0.1.0" },
    servers: [{ url: `${publicUrl(req)}/api` }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: {
      "/capabilities": { get: { summary: "List capabilities" }, post: { summary: "Create/update capability" } },
      "/capabilities/{id}": { get: { summary: "Describe capability" }, patch: { summary: "Update capability" } },
      "/capabilities/{id}/run": { post: { summary: "Run capability" } },
      "/runs": { get: { summary: "List runs" } },
      "/runs/{id}": { get: { summary: "Get run" } },
      "/runs/{id}/events": { get: { summary: "Get run events" }, post: { summary: "Append run event" } },
      "/runs/{id}/artifacts": { get: { summary: "List run artifacts" }, post: { summary: "Upload artifact" } },
      "/approvals": { get: { summary: "List approvals" } },
      "/approvals/{id}/approve": { post: { summary: "Approve request" } },
      "/approvals/{id}/reject": { post: { summary: "Reject request" } },
      "/runners/register": { post: { summary: "Register runner" } },
      "/runners/{id}/next-run": { get: { summary: "Claim next run for runner" } }
    }
  });
});

app.get("/api/setup", (_req, res) => {
  res.json({
    instanceName: env.instanceName,
    baseUrl: env.baseUrl,
    auth: "access-token",
    telegramConfigured: Boolean(env.telegramBotToken && env.telegramChatId),
    telegramWebhookSecured: Boolean(env.telegramWebhookSecret),
    dataDir: env.dataDir
  });
});

app.post("/api/auth/token-login", rateLimit({ bucket: "login", max: 10, windowMs: 60_000 }), (req, res) => {
  const token = req.body.token || "";
  const record = authenticateToken(token);
  if (!record) return res.status(401).json({ error: "invalid token" });
  sendSession(res, token);
  recordAudit(record.name, "auth.login", record.id, {});
  res.json({ ok: true, token: { id: record.id, name: record.name, scopes: record.scopes } });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("shub_session", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ token: { id: req.token.id, name: req.token.name, scopes: req.token.scopes } });
});

app.get("/api/tokens", requireAuth, requireScopes("admin"), (_req, res) => {
  res.json({ tokens: listAccessTokens() });
});

app.post("/api/tokens", requireAuth, requireScopes("admin"), (req, res) => {
  const scopes = Array.isArray(req.body.scopes) && req.body.scopes.length ? req.body.scopes : ["api", "mcp"];
  const days = Number(req.body.expiresInDays || 0);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
  const token = createAccessToken(req.body.name || "access token", undefined, scopes, { expiresAt });
  recordAudit(req.token.name, "token.created", token.id, { scopes, expiresAt });
  res.json({ token });
});

app.get("/api/audit", requireAuth, requireScopes("admin"), (req, res) => {
  res.json({ audit: listAudit({ limit: Number(req.query.limit || 100) }) });
});

app.delete("/api/tokens/:id", requireAuth, requireScopes("admin"), (req, res) => {
  // Don't let an operator revoke the last usable admin token and lock everyone out.
  const tokens = listAccessTokens();
  const target = tokens.find((entry) => entry.id === req.params.id);
  if (!target) return res.status(404).json({ error: "token not found" });
  const activeAdmins = tokens.filter((entry) => entry.active && entry.scopes.includes("admin"));
  if (target.active && target.scopes.includes("admin") && activeAdmins.length <= 1) {
    return res.status(409).json({ error: "cannot revoke the last active admin token" });
  }
  const revoked = revokeAccessToken(req.params.id);
  recordAudit(req.token.name, "token.revoked", req.params.id, {});
  res.json({ token: revoked });
});

app.get("/api/dashboard", requireAuth, (_req, res) => {
  res.json({ stats: dashboardStats(), recentRuns: listRuns({ limit: 8 }), pendingApprovals: listApprovals("pending") });
});

app.get("/api/capabilities", requireAuth, (req, res) => {
  // Catalog shows enabled capabilities; admins can include disabled with ?all=1.
  const includeDisabled = req.query.all === "1" && (req.token.scopes || []).includes("admin");
  res.json({ capabilities: listCapabilities({ q: req.query.q || "", includeDisabled }) });
});

app.post("/api/capabilities", requireAuth, requireScopes("admin"), (req, res) => {
  const body = { ...req.body, slug: requireBodySlug(req.body, "capability") };
  res.json({ capability: upsertCapability(body) });
});

app.get("/api/capabilities/:id", requireAuth, (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability) return res.status(404).json({ error: "capability not found" });
  res.json({ capability });
});

app.patch("/api/capabilities/:id", requireAuth, requireScopes("admin"), (req, res) => {
  const existing = getCapability(req.params.id);
  if (!existing) return res.status(404).json({ error: "capability not found" });
  res.json({ capability: upsertCapability({ ...existing, ...req.body, slug: existing.slug }) });
});

app.post("/api/capabilities/:id/run", requireAuth, requireScopes("api", "mcp"), async (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability || !capability.enabled) return res.status(404).json({ error: "capability not found" });
  const run = createRun(capability, req.body.input || req.body || {}, { runnerId: req.body.runnerId });
  const pending = listApprovals("pending").find((approval) => approval.runId === run.id);
  if (pending) await notifyTelegram(pending);
  res.status(202).json({ run, statusUrl: `/api/runs/${run.id}`, webUrl: `/app#runs/${run.id}` });
});

app.get("/api/agents", requireAuth, (req, res) => res.json({ agents: listAgents(req.query.q || "") }));
app.post("/api/agents", requireAuth, requireScopes("admin"), (req, res) => res.json({ agent: upsertAgent({ ...req.body, slug: requireBodySlug(req.body, "agent") }) }));
app.patch("/api/agents/:slug", requireAuth, requireScopes("admin"), (req, res) => res.json({ agent: upsertAgent({ ...req.body, slug: req.params.slug }) }));

app.get("/api/skills", requireAuth, (req, res) => res.json({ skills: listSkills(req.query.q || "") }));
app.post("/api/skills", requireAuth, requireScopes("admin"), (req, res) => res.json({ skill: upsertSkill({ ...req.body, slug: requireBodySlug(req.body, "skill") }) }));
app.patch("/api/skills/:slug", requireAuth, requireScopes("admin"), (req, res) => res.json({ skill: upsertSkill({ ...req.body, slug: req.params.slug }) }));

app.get("/api/knowledge", requireAuth, (req, res) => res.json({ knowledge: listKnowledge(req.query.q || "") }));
app.post("/api/knowledge", requireAuth, requireScopes("admin"), (req, res) =>
  res.json({ knowledge: upsertKnowledge({ ...req.body, slug: requireBodySlug(req.body, "knowledge") }) })
);
app.patch("/api/knowledge/:slug", requireAuth, requireScopes("admin"), (req, res) => res.json({ knowledge: upsertKnowledge({ ...req.body, slug: req.params.slug }) }));

app.get("/api/runs", requireAuth, (req, res) => {
  reapStuckRuns(env.runDeadlineMs);
  const status = req.query.status || "";
  const limit = Math.min(Number(req.query.limit || 100), 500);
  res.json({ runs: listRuns({ status, limit }), total: countRuns({ status }), limit });
});
app.get("/api/runs/:id", requireAuth, (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json({ run, events: listRunEvents(run.id), artifacts: listArtifacts({ runId: run.id }) });
});
app.get("/api/runs/:id/events", requireAuth, (req, res) => res.json({ events: listRunEvents(req.params.id) }));
app.get("/api/runs/:id/logs", requireAuth, (req, res) => {
  const logs = listRunEvents(req.params.id)
    .map((event) => `[${event.createdAt}] ${event.type}: ${event.message}`)
    .join("\n");
  res.type("text/plain").send(logs);
});
app.post("/api/runs/:id/events", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const event = addRunEvent(req.params.id, req.body.type || "log", req.body.message || "", req.body.data || {});
  if (req.body.type === "workflow.step") updateRun(req.params.id, { current_step: req.body.message || "" });
  res.json({ event });
});
app.post("/api/runs/:id/start", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const result = transitionRun(req.params.id, "running", { current_step: "running", started_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (!result.idempotent) addRunEvent(req.params.id, "run.started", "Run started");
  res.json({ run: result.run });
});
app.post("/api/runs/:id/complete", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const result = transitionRun(req.params.id, "succeeded", { current_step: "completed", output: req.body.output || {}, completed_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (!result.idempotent) addRunEvent(req.params.id, "run.succeeded", "Run completed");
  res.json({ run: result.run });
});
app.post("/api/runs/:id/fail", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const result = transitionRun(req.params.id, "failed", { current_step: "failed", error: req.body.error || "failed", completed_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (!result.idempotent) addRunEvent(req.params.id, "run.failed", req.body.error || "Run failed");
  res.json({ run: result.run });
});
app.post("/api/runs/:id/cancel", requireAuth, requireScopes("api", "mcp", "runner"), (req, res) => {
  const result = transitionRun(req.params.id, "cancelled", { current_step: "cancelled", completed_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (!result.idempotent) addRunEvent(req.params.id, "run.cancelled", req.body.reason || "Run cancelled");
  res.json({ run: result.run });
});

app.get("/api/runs/:id/artifacts", requireAuth, (req, res) => res.json({ artifacts: listArtifacts({ runId: req.params.id }) }));
app.post("/api/runs/:id/artifacts", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const runDir = path.join(env.artifactDir, "runs", req.params.id);
  mkdirSync(runDir, { recursive: true });
  const safeName = String(req.body.name || "artifact.txt").replace(/[/\\]/g, "-");
  const filePath = path.join(runDir, safeName);
  const content = req.body.contentBase64 ? Buffer.from(req.body.contentBase64, "base64") : Buffer.from(String(req.body.content || ""));
  writeFileSync(filePath, content);
  const stats = statSync(filePath);
  const artifact = createArtifact({
    runId: req.params.id,
    name: safeName,
    mimeType: req.body.mimeType || "application/octet-stream",
    sizeBytes: stats.size,
    path: filePath,
    metadata: req.body.metadata || {}
  });
  res.json({ artifact });
});

app.get("/api/artifacts", requireAuth, (req, res) => res.json({ artifacts: listArtifacts({ q: req.query.q || "" }) }));
app.get("/api/artifacts/:id/download", requireAuth, (req, res) => {
  const artifact = getArtifact(req.params.id);
  if (!artifact) return res.status(404).json({ error: "artifact not found" });
  // Containment: never serve a file that resolved outside the artifact directory.
  const resolved = path.resolve(artifact.path);
  if (!resolved.startsWith(path.resolve(env.artifactDir) + path.sep)) {
    return res.status(400).json({ error: "artifact path outside storage root" });
  }
  res.type(artifact.mimeType);
  // Force download so HTML/SVG artifacts never execute in the Hub origin.
  res.setHeader("content-disposition", `attachment; filename="${path.basename(artifact.name).replace(/["\r\n]/g, "")}"`);
  res.send(readFileSync(resolved));
});

app.get("/api/approvals", requireAuth, (req, res) => res.json({ approvals: listApprovals(req.query.status || "") }));
app.post("/api/approvals/:id/approve", requireAuth, requireScopes("api", "mcp"), (req, res) =>
  res.json({ approval: resolveApproval(req.params.id, "approved", req.token.name, req.body.comment || "") })
);
app.post("/api/approvals/:id/reject", requireAuth, requireScopes("api", "mcp"), (req, res) =>
  res.json({ approval: resolveApproval(req.params.id, "rejected", req.token.name, req.body.comment || "") })
);

app.post("/api/runners/register", requireAuth, requireScopes("runner"), (req, res) => {
  const runner = registerRunner(req.body, req.token.id);
  res.json({ runner });
});
app.get("/api/runners", requireAuth, (_req, res) => res.json({ runners: listRunners() }));
app.post("/api/runners/:id/heartbeat", requireAuth, requireScopes("runner"), (req, res) => res.json({ runner: heartbeatRunner(req.params.id, req.body) }));
app.get("/api/runners/:id/next-run", requireAuth, requireScopes("runner"), async (req, res) => {
  const { claimNextRun } = await import("./db.js");
  res.json(claimNextRun(req.params.id) || {});
});

app.post("/api/telegram/webhook", (req, res) => {
  // Telegram authenticates webhooks via a secret token header configured on setWebhook.
  // Without a configured secret we refuse to act, so the endpoint can't be used to forge approvals.
  if (!env.telegramWebhookSecret) return res.status(503).json({ ok: false, error: "telegram webhook not configured" });
  const provided = req.headers["x-telegram-bot-api-secret-token"] || "";
  if (!timingSafeEqualStr(provided, env.telegramWebhookSecret)) return res.status(401).json({ ok: false });
  const callback = req.body.callback_query;
  if (callback?.data) {
    // Only honor callbacks originating from the configured chat.
    const chatId = String(callback.message?.chat?.id ?? "");
    if (env.telegramChatId && chatId && chatId !== String(env.telegramChatId)) {
      return res.status(403).json({ ok: false });
    }
    const [decision, approvalId] = callback.data.split(":");
    const who = `telegram:${callback.from?.username || callback.from?.id || "user"}`;
    if (decision === "approve") resolveApproval(approvalId, "approved", who, "");
    if (decision === "reject") resolveApproval(approvalId, "rejected", who, "");
  }
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  // Respect known client errors (body too large, malformed JSON) but never leak internals.
  const status = error.status || error.statusCode;
  if (status === 413) return res.status(413).json({ error: "payload too large" });
  if (status === 400 && error.type) return res.status(400).json({ error: "invalid request body" });
  res.status(500).json({ error: "internal server error" });
});

if (process.argv[1]?.endsWith("server.js")) {
  app.listen(env.port, env.host, () => {
    console.log(`${env.instanceName} listening on http://${env.host}:${env.port}`);
  });
  // Periodically auto-fail runs whose runner died mid-execution.
  const reaper = setInterval(() => {
    try {
      reapStuckRuns(env.runDeadlineMs);
    } catch (error) {
      console.error("Run reaper failed:", error.message);
    }
  }, 60_000);
  reaper.unref?.();
}

export { app };
