import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  getRun,
  heartbeatRunner,
  listAgents,
  listApprovals,
  listArtifacts,
  listCapabilities,
  listKnowledge,
  listRunEvents,
  listRunners,
  listRuns,
  listSkills,
  registerRunner,
  resolveApproval,
  upsertAgent,
  upsertCapability,
  upsertKnowledge,
  upsertSkill,
  updateRun
} from "./db.js";
import { env } from "./env.js";
import { now, slugify } from "./ids.js";
import { parseCookies, sign, unsign } from "./security.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false }));

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
  next();
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
    dataDir: env.dataDir
  });
});

app.post("/api/auth/token-login", (req, res) => {
  const token = req.body.token || "";
  const record = authenticateToken(token);
  if (!record) return res.status(401).json({ error: "invalid token" });
  sendSession(res, token);
  res.json({ ok: true, token: { id: record.id, name: record.name, scopes: record.scopes } });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("shub_session", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ token: { id: req.token.id, name: req.token.name, scopes: req.token.scopes } });
});

app.post("/api/tokens", requireAuth, (req, res) => {
  const token = createAccessToken(req.body.name || "access token", undefined, req.body.scopes || ["api", "mcp"]);
  res.json({ token });
});

app.get("/api/dashboard", requireAuth, (_req, res) => {
  res.json({ stats: dashboardStats(), recentRuns: listRuns({ limit: 8 }), pendingApprovals: listApprovals("pending") });
});

app.get("/api/capabilities", requireAuth, (req, res) => {
  res.json({ capabilities: listCapabilities({ q: req.query.q || "" }) });
});

app.post("/api/capabilities", requireAuth, (req, res) => {
  const body = { ...req.body, slug: requireBodySlug(req.body, "capability") };
  res.json({ capability: upsertCapability(body) });
});

app.get("/api/capabilities/:id", requireAuth, (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability) return res.status(404).json({ error: "capability not found" });
  res.json({ capability });
});

app.patch("/api/capabilities/:id", requireAuth, (req, res) => {
  const existing = getCapability(req.params.id);
  if (!existing) return res.status(404).json({ error: "capability not found" });
  res.json({ capability: upsertCapability({ ...existing, ...req.body, slug: existing.slug }) });
});

app.post("/api/capabilities/:id/run", requireAuth, async (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability || !capability.enabled) return res.status(404).json({ error: "capability not found" });
  const run = createRun(capability, req.body.input || req.body || {}, { runnerId: req.body.runnerId });
  const pending = listApprovals("pending").find((approval) => approval.runId === run.id);
  if (pending) await notifyTelegram(pending);
  res.status(202).json({ run, statusUrl: `/api/runs/${run.id}`, webUrl: `/app#runs/${run.id}` });
});

app.get("/api/agents", requireAuth, (req, res) => res.json({ agents: listAgents(req.query.q || "") }));
app.post("/api/agents", requireAuth, (req, res) => res.json({ agent: upsertAgent({ ...req.body, slug: requireBodySlug(req.body, "agent") }) }));
app.patch("/api/agents/:slug", requireAuth, (req, res) => res.json({ agent: upsertAgent({ ...req.body, slug: req.params.slug }) }));

app.get("/api/skills", requireAuth, (req, res) => res.json({ skills: listSkills(req.query.q || "") }));
app.post("/api/skills", requireAuth, (req, res) => res.json({ skill: upsertSkill({ ...req.body, slug: requireBodySlug(req.body, "skill") }) }));
app.patch("/api/skills/:slug", requireAuth, (req, res) => res.json({ skill: upsertSkill({ ...req.body, slug: req.params.slug }) }));

app.get("/api/knowledge", requireAuth, (req, res) => res.json({ knowledge: listKnowledge(req.query.q || "") }));
app.post("/api/knowledge", requireAuth, (req, res) =>
  res.json({ knowledge: upsertKnowledge({ ...req.body, slug: requireBodySlug(req.body, "knowledge") }) })
);
app.patch("/api/knowledge/:slug", requireAuth, (req, res) => res.json({ knowledge: upsertKnowledge({ ...req.body, slug: req.params.slug }) }));

app.get("/api/runs", requireAuth, (req, res) => res.json({ runs: listRuns({ status: req.query.status || "", limit: Number(req.query.limit || 100) }) }));
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
app.post("/api/runs/:id/events", requireAuth, (req, res) => {
  const event = addRunEvent(req.params.id, req.body.type || "log", req.body.message || "", req.body.data || {});
  if (req.body.type === "workflow.step") updateRun(req.params.id, { current_step: req.body.message || "" });
  res.json({ event });
});
app.post("/api/runs/:id/start", requireAuth, (req, res) => {
  const run = updateRun(req.params.id, { status: "running", current_step: "running", started_at: now() });
  addRunEvent(req.params.id, "run.started", "Run started");
  res.json({ run });
});
app.post("/api/runs/:id/complete", requireAuth, (req, res) => {
  const run = updateRun(req.params.id, { status: "succeeded", current_step: "completed", output: req.body.output || {}, completed_at: now() });
  addRunEvent(req.params.id, "run.succeeded", "Run completed");
  res.json({ run });
});
app.post("/api/runs/:id/fail", requireAuth, (req, res) => {
  const run = updateRun(req.params.id, { status: "failed", current_step: "failed", error: req.body.error || "failed", completed_at: now() });
  addRunEvent(req.params.id, "run.failed", req.body.error || "Run failed");
  res.json({ run });
});
app.post("/api/runs/:id/cancel", requireAuth, (req, res) => {
  const run = updateRun(req.params.id, { status: "cancelled", current_step: "cancelled", completed_at: now() });
  addRunEvent(req.params.id, "run.cancelled", req.body.reason || "Run cancelled");
  res.json({ run });
});

app.get("/api/runs/:id/artifacts", requireAuth, (req, res) => res.json({ artifacts: listArtifacts({ runId: req.params.id }) }));
app.post("/api/runs/:id/artifacts", requireAuth, (req, res) => {
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
  res.type(artifact.mimeType);
  res.send(readFileSync(artifact.path));
});

app.get("/api/approvals", requireAuth, (req, res) => res.json({ approvals: listApprovals(req.query.status || "") }));
app.post("/api/approvals/:id/approve", requireAuth, (req, res) =>
  res.json({ approval: resolveApproval(req.params.id, "approved", req.token.name, req.body.comment || "") })
);
app.post("/api/approvals/:id/reject", requireAuth, (req, res) =>
  res.json({ approval: resolveApproval(req.params.id, "rejected", req.token.name, req.body.comment || "") })
);

app.post("/api/runners/register", requireAuth, (req, res) => {
  const runner = registerRunner(req.body, req.token.id);
  res.json({ runner });
});
app.get("/api/runners", requireAuth, (_req, res) => res.json({ runners: listRunners() }));
app.post("/api/runners/:id/heartbeat", requireAuth, (req, res) => res.json({ runner: heartbeatRunner(req.params.id, req.body) }));
app.get("/api/runners/:id/next-run", requireAuth, async (req, res) => {
  const { claimNextRun } = await import("./db.js");
  res.json(claimNextRun(req.params.id) || {});
});

app.post("/api/telegram/webhook", express.json(), (req, res) => {
  const callback = req.body.callback_query;
  if (callback?.data) {
    const [decision, approvalId] = callback.data.split(":");
    if (decision === "approve") resolveApproval(approvalId, "approved", `telegram:${callback.from?.username || callback.from?.id || "user"}`, "");
    if (decision === "reject") resolveApproval(approvalId, "rejected", `telegram:${callback.from?.username || callback.from?.id || "user"}`, "");
  }
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "internal server error", detail: error.message });
});

if (process.argv[1]?.endsWith("server.js")) {
  app.listen(env.port, env.host, () => {
    console.log(`${env.instanceName} listening on http://${env.host}:${env.port}`);
  });
}

export { app };
