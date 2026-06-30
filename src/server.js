import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import express from "express";
import { asyncHandler } from "./http.js";
import { createRateLimiter, securityHeaders } from "./httpMiddleware.js";
import { createCliTarballBuilder, installScript } from "./clientInstall.js";
import {
  hubMenuPayload as buildHubMenuPayload,
  openApiDocument,
  renderLlmsTxt
} from "./discoveryDocs.js";
import { absoluteDeepLink, deepLinks, withAgentLinks, withArtifactLinks, withCapabilityLinks } from "./deepLinks.js";
import { registerRunnerRoutes } from "./routes/runners.js";
import { subscribeRunEvents } from "./runEventBus.js";
import { buildHubRepairInput } from "./hubSupervisor.js";
import {
  addRunEvent,
  authenticateToken,
  approvalPolicyNotifiesTelegram,
  createAccessToken,
  createApproval,
  createArtifact,
  createRun,
  DEFAULT_HIDDEN_RUN_SLUGS,
  countWorkflowEndpointInvocations,
  dashboardStats,
  findActiveSupervisorByToken,
  findRecentWorkflowEndpointInvocation,
  getArtifact,
  getApproval,
  getCapability,
  getWorkflowEndpoint,
  countRuns,
  createRunResponseEndpoint,
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  setScheduleEnabled,
  deleteSchedule,
  listDueSchedules,
  claimScheduleFire,
  recordScheduleFireResult,
  getRun,
  listRunResponseEndpointsForRun,
  listAccessTokens,
  listAgents,
  listApprovals,
  listAudit,
  listArtifacts,
  listCapabilities,
  listCapabilityVersionsFromRuns,
  listKnowledge,
  listRunEvents,
  listRuns,
  listSkills,
  listWorkflowEndpoints,
  pruneDeadRunners,
  reapStuckRunIds,
  reconcileFailedRecoverable,
  reconcileRepairChildTerminal,
  reconcileRunnerActiveRuns,
  recordWorkflowEndpointInvocation,
  recordAudit,
  resolveApproval,
  revokeAccessToken,
  runOwnerTokenId,
  runnerPoolStats,
  transitionRun,
  upsertAgent,
  upsertCapability,
  upsertKnowledge,
  upsertSkill,
  upsertWorkflowEndpoint,
  updateRun,
  listSecretMeta,
  getSecretMeta,
  secretExists,
  upsertSecret,
  deleteSecret,
  secretsEnabled,
  scrubStoredSecrets,
  recordAlert,
  listAlerts,
  latestAlert,
  countActiveRuns,
  countRunningRuns
} from "./db.js";
import { env } from "./env.js";
import { getVersionInfo } from "./version.js";
import { createUpdateChecker } from "./updateCheck.js";
import { now } from "./ids.js";
import { classifyFailureStatus, failureEventType, normalizeFailureStatus } from "./runFailureClass.js";
import {
  buildRunTimeline,
  timelinePage
} from "./runTimeline.js";
import {
  capabilityVersioningEnabled,
  executionIntentFromInput,
  normalizeExecutionIntent,
  resolveCapabilityVersionOptions
} from "./runExecution.js";
import {
  parseResponseEndpoint,
  presentRunResponseEndpoint,
  safeResponseEndpointAuditDetail
} from "./runResponseEndpoint.js";
import { scheduleRunResponseEndpointDelivery } from "./runResponseEndpointDelivery.js";
import { createRunTerminalArtifactService } from "./runTerminalArtifacts.js";
import {
  redactSnippet,
  summarizeRunEvents
} from "./runEventSummary.js";
import { truncate } from "./presentation.js";
import { chatWithSupportAgent, supportAgentInfo } from "./runyardSupportAgent.js";
import { buildSupportLiveContext } from "./supportContext.js";
import { hashToken, parseCookies, sign, timingSafeEqualStr, unsign } from "./security.js";
import { buildRepoCatalog, resolveCapabilityRef } from "./repoCatalog.js";
import {
  deriveWorkflowGraph,
  deriveWorkflowGraphFromMetadata,
  loadWorkflowSource,
  parseWorkflowMetadata,
  sliceWorkflowSections
} from "./workflowSource.js";
import {
  bodySizeBytes,
  workflowEndpointPayloadHash,
  workflowEndpointRunInput
} from "./workflowEndpointSubmission.js";
import {
  attachChainToInput,
  chainMetadata,
  nextChainedRunInput,
  nextChainedRunOrigin
} from "./workflowChain.js";
import {
  TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS,
  authenticateTelegramWebAppSession,
  createTelegramWebAppSession,
  telegramSessionCanAccess,
  telegramUserLabel,
  verifyTelegramWebAppInitData
} from "./telegramWebAppAuth.js";
import {
  approvalDecisionLabel,
  firstCsvValue,
  parseTelegramApprovalCallback,
  shouldNotifyTelegram as shouldNotifyTelegramApproval,
  telegramApprovalButtonClearPayload,
  telegramApprovalMessagePayload,
  telegramApprovalTarget as resolveTelegramApprovalTarget
} from "./telegramApprovals.js";
import {
  approvalCreateInput,
  decisionTriggersTerminalDelivery,
  defaultApprovalComment,
  findExistingChildRunApproval as findMatchingChildRunApproval
} from "./approvalRoutes.js";
import {
  approvalContext as buildApprovalContext,
  sanitizeForDisplay,
  withApprovalLinks as decorateApprovalLinks
} from "./approvalPresentation.js";
import {
  buildQueueIndex,
  deriveRunDescription,
  deriveRunTitle,
  withRunLinks as decorateRunLinks
} from "./runPresentation.js";
import {
  runDiagnostics as buildRunDiagnostics
} from "./runDiagnostics.js";
import {
  SUPERVISOR_CAPABILITY_SLUG,
  buildSupervisorInput,
  decideSupervision,
  mintSupervisionToken,
  stripSupervisionInternals
} from "./supervision.js";
import {
  cleanRerunInput,
  findActiveDuplicateRerun as findDuplicateRerun
} from "./runRerun.js";
import { schedulePreview, validateScheduleBody, withScheduleView } from "./scheduleHelpers.js";
import { bearerFromRequest, requestOrigin, requireBodySlug } from "./requestContext.js";
import {
  actorName as secretActorName,
  secretsDisabledResponse,
  validateSecretUpsert
} from "./secretsRoutes.js";
import {
  revokeTokenDecision,
  tokenCreateInput
} from "./tokenRoutes.js";
import { maybeRecordFailureClassAlert as maybeRecordFailureAlert } from "./failureAlerts.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", env.trustProxy);

// Passive update checker (the CHECK half of CHECK != APPLY). Outbound-only,
// read-only GitHub Releases poll with a ~1h cache; degrades to "unknown" on any
// failure and never installs anything. Swappable in tests via
// setUpdateCheckerForTest so the suite never makes a live network call.
let updateChecker = createUpdateChecker({
  repo: env.githubRepo,
  currentVersion: getVersionInfo().version,
  ttlMs: env.updateCheckIntervalMs
});
export function setUpdateCheckerForTest(checker) {
  updateChecker = checker;
}

// Modest global body limit; artifact uploads (which carry base64 file content) get a larger one.
const ARTIFACT_BODY_LIMIT = "25mb";
const globalJson = express.json({ limit: "1mb" });
const artifactJson = express.json({ limit: ARTIFACT_BODY_LIMIT });
const isArtifactUpload = (req) => req.method === "POST" && /^\/api\/runs\/[^/]+\/artifacts\/?$/.test(req.path);
app.use((req, res, next) => (isArtifactUpload(req) ? artifactJson : globalJson)(req, res, next));
app.use(express.urlencoded({ extended: false }));

const startedAt = Date.now();
const SESSION_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365;
const rateLimiter = createRateLimiter();
const rateLimit = rateLimiter.middleware;

function publicUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

const runPresentationDeps = {
  getCapability,
  getRun
};

const runDiagnosticsDeps = {
  listApprovals,
  sanitizeForDisplay,
  withArtifactLinks
};

function runDiagnostics(run, events = [], artifacts = []) {
  return buildRunDiagnostics(run, events, artifacts, runDiagnosticsDeps);
}

function withRunLinks(run, queueIndex = null) {
  return decorateRunLinks(run, queueIndex, runPresentationDeps);
}

// When we have a single run (not a list), compute its queue position on the
// fly from the live queued backlog.
function decorateSingleRun(run) {
  if (!run) return run;
  if (run.status !== "queued") return withRunLinks(run);
  const queueIndex = buildQueueIndex(listRuns({ status: "queued", limit: 500 }));
  return withRunLinks(run, queueIndex);
}

const {
  dispatchRunResponseEndpointDelivery,
  recordRunTerminalArtifacts,
  reapStuckRunsWithRetrospectives,
  storeRunArtifact
} = createRunTerminalArtifactService({
  env,
  createArtifact,
  getRun,
  listArtifacts,
  listRunEvents,
  getCapability,
  withArtifactLinks,
  withRunLinks,
  withCapabilityLinks,
  summarizeRunEvents,
  runDiagnostics,
  scrubStoredSecrets,
  addRunEvent,
  scheduleRunResponseEndpointDelivery,
  reconcileRepairChildTerminal,
  reapStuckRunIds
});

// Single choke point for turning a run request into a created run, applying the
// default supervision envelope. `improve` / `idea-to-product` (and anything
// flagged `supervision.default`) are wrapped in a visible run-smithers
// supervising run so failures surface as attention-needed instead of a silent
// success. The wrapper is never wrapped, and a verified supervised child run
// (carrying the internal bypass token) is dispatched directly — this is what
// stops the envelope from recursing forever. See src/supervision.js.
function dispatchRun(capability, input, options = {}) {
  const decision = decideSupervision(capability, input, {
    findSupervisorByToken: findActiveSupervisorByToken
  });

  if (decision.action === "wrap") {
    const supervisorCapability = getCapability(SUPERVISOR_CAPABILITY_SLUG);
    if (supervisorCapability && supervisorCapability.enabled) {
      const token = mintSupervisionToken();
      const goal = typeof input?.goal === "string" && input.goal.trim() ? input.goal.trim() : "";
      const supervisorInput = buildSupervisorInput({ capability, input, goal, token });
      const run = createRun(supervisorCapability, supervisorInput, {
        ...options,
        origin: { ...(options.origin || {}), supervises: capability.slug, wrappedCapability: capability.slug }
      });
      addRunEvent(run.id, "run.supervision.wrapped", `Supervising ${capability.name} via run-smithers`, {
        wrappedCapability: capability.slug,
        wrappedCapabilityName: capability.name
      });
      return {
        run,
        supervising: {
          supervisor: SUPERVISOR_CAPABILITY_SLUG,
          wrappedCapability: capability.slug,
          wrappedCapabilityName: capability.name
        }
      };
    }
    // Supervisor capability missing/disabled — fall through to a direct run
    // rather than blocking the user entirely.
  }

  if (decision.parentRunId) {
    const childInput = stripSupervisionInternals(input);
    const origin = {
      ...(options.origin || {}),
      type: "run-smithers-child",
      parentRunId: decision.parentRunId,
      label: (options.origin && options.origin.label) || `Supervised child of ${decision.parentRunId}`
    };
    const run = createRun(capability, childInput, { ...options, origin });
    addRunEvent(run.id, "run.supervision.child", `Supervised child run of ${decision.parentRunId}`, {
      parentRunId: decision.parentRunId,
      deepLink: deepLinks.run(decision.parentRunId)
    });
    addRunEvent(decision.parentRunId, "run.supervision.spawned_child", `Spawned supervised child run ${run.id}`, {
      childRunId: run.id,
      capability: capability.slug,
      deepLink: deepLinks.run(run.id)
    });
    return { run, supervisedChild: { parentRunId: decision.parentRunId } };
  }

  return { run: createRun(capability, input, options) };
}

// Phase 2 (flag-gated, default OFF): the hub's one-shot code-repair dispatcher.
// Invoked by the failed-recoverable reconcile only when the classifier judged a
// failure a deterministic workflow-code bug AND HUB_SUPERVISOR_REPAIR_ENABLED is
// set. It creates a single `implement-change-gated` run that edits the failing
// workflow's source, then returns true so the reconcile loop bumps the
// per-fingerprint repair counter and resumes. Any error → false → the reconcile
// loop escalates to an operator card instead of looping. Bounded by the
// per-fingerprint repair cap enforced upstream in src/hubSupervisor.js.
function dispatchHubRepair(failedRun, decision) {
  try {
    const capability = getCapability("implement-change-gated");
    if (!capability || !capability.enabled) return false;
    const wrapped = getCapability(failedRun.capabilitySlug);
    // Safety-scoped repair input (see buildHubRepairInput): forces a dedicated
    // repair branch (never main), inherits the failed run's runner routing so
    // the repair lands on the SAME runner class/repo that ran the failed
    // workflow, and forwards its repo selector. Without this the repair could be
    // claimed by any `smithers` runner (including production) and pushed to main.
    const repairInput = buildHubRepairInput(failedRun, decision, {
      wrappedEntry: wrapped?.workflow?.entry || "",
      repairBranch: process.env.RUN_SMITHERS_REPAIR_BRANCH || "smithers-self-repair"
    });
    // The hub IS the supervisor here, so create the repair as a DIRECT run. The
    // old code routed through dispatchRun, which re-wrapped it in another
    // run-smithers envelope that ran on an arbitrary runner and nested a
    // redundant supervisor; a direct run keeps the execution routing intact so
    // only the inherited runner location can claim it.
    const createOptions = {
      requestedBy: "system:hub-supervisor",
      origin: { type: "hub-supervisor-repair", repairsRunId: failedRun.id, fingerprint: decision.fingerprint || "" }
    };
    if (!repairInput.__execution?.runnerLocation && failedRun.runnerId) {
      createOptions.runnerId = failedRun.runnerId;
    }
    const run = createRun(capability, repairInput, createOptions);
    addRunEvent(failedRun.id, "run.supervisor.repair_child", `Hub dispatched code repair run ${run.id}`, {
      repairRunId: run.id,
      fingerprint: decision.fingerprint || "",
      targetBranch: repairInput.targetBranch,
      runnerLocation: repairInput.__execution?.runnerLocation || "",
      runnerId: createOptions.runnerId || ""
    });
    // Return the child run id so the reconcile loop can park the parent ON this
    // specific child and re-run it fresh once the child terminates.
    return run?.id || "";
  } catch (error) {
    console.error("hub repair dispatch failed:", error.message);
    return "";
  }
}

function hubMenuPayload(req) {
  return buildHubMenuPayload({
    baseUrl: publicUrl(req),
    capabilities: listCapabilities().map(withCapabilityLinks),
    pool: runnerPoolStats()
  });
}

const approvalPresentationDeps = {
  getRun,
  getCapability,
  deriveRunTitle,
  deriveRunDescription
};

function approvalContext(approval) {
  return buildApprovalContext(approval, approvalPresentationDeps);
}

function withApprovalLinks(approval) {
  return decorateApprovalLinks(approval, approvalPresentationDeps);
}

function authenticateSessionValue(value) {
  return authenticateTelegramWebAppSession(value, {
    approvalUserIds: env.telegramApprovalUserIds,
    approvalChatId: env.telegramApprovalChatId
  }) || authenticateToken(value);
}

function authFromRequest(req) {
  const header = req.headers.authorization || "";
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

function findActiveDuplicateRerun({ previousRunId, capabilitySlug, input }) {
  return findDuplicateRerun(listRuns({ limit: 500, includeInternal: true }), { previousRunId, capabilitySlug, input });
}

function sendSessionValue(res, value, maxAge = SESSION_COOKIE_MAX_AGE_MS) {
  res.cookie("shub_session", sign(value), {
    httpOnly: true,
    secure: env.baseUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge
  });
}

function sendSession(res, token) {
  sendSessionValue(res, token);
}

// Restrict a run's lifecycle endpoints to the runner that owns it (or any admin token).
function requireRunOwnerOrAdmin(req, res, next) {
  const scopes = req.token?.scopes || [];
  if (scopes.includes("admin")) return next();
  if (!getRun(req.params.id)) return res.status(404).json({ error: "run not found" });
  if (runOwnerTokenId(req.params.id) === req.token.id) return next();
  return res.status(403).json({ error: "run not owned by this runner" });
}

function telegramApprovalTarget() {
  return resolveTelegramApprovalTarget({
    approvalChatId: env.telegramApprovalChatId,
    telegramChatId: env.telegramChatId,
    telegramThreadId: env.telegramThreadId
  });
}

function shouldNotifyTelegram(approval) {
  return shouldNotifyTelegramApproval(approval, { getRun, getCapability });
}

async function notifyTelegram(approval) {
  const target = telegramApprovalTarget();
  if (!env.telegramBotToken || !target) return;
  if (!shouldNotifyTelegram(approval)) return;
  const approvalUrl = absoluteDeepLink(deepLinks.approval(approval.id), env.baseUrl);
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramApprovalMessagePayload({
        target,
        approval,
        approvalUrl,
        approvalContext,
        instanceName: env.instanceName
      }))
    });
    if (!response.ok) console.error("Telegram notification failed:", response.status);
  } catch (error) {
    console.error("Telegram notification failed:", error.message);
  }
}

async function answerTelegramCallbackQuery(callbackQueryId, text) {
  if (!callbackQueryId || !env.telegramBotToken) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: truncate(text, 180), show_alert: false })
    });
    if (!response.ok) console.error("Telegram callback acknowledgement failed:", response.status);
  } catch (error) {
    console.error("Telegram callback acknowledgement failed:", error.message);
  }
}

async function clearTelegramApprovalButtons(callback) {
  if (!env.telegramBotToken) return;
  const payload = telegramApprovalButtonClearPayload(callback);
  if (!payload) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) console.error("Telegram approval button cleanup failed:", response.status);
  } catch (error) {
    console.error("Telegram approval button cleanup failed:", error.message);
  }
}

app.use(securityHeaders({ baseUrl: env.baseUrl }));

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
app.get("/api/version", (_req, res) => res.json({ name: "runyard", version: env.version, instanceName: env.instanceName }));
// Canonical running version. Unauthenticated on purpose — it's just the version
// the box is running (a public release string + tag + short commit), nothing
// sensitive. Used by the update-check comparison and by operators/monitoring.
app.get("/version", (_req, res) => {
  const info = getVersionInfo();
  res.json({ version: info.version, gitTag: info.gitTag, gitCommit: info.gitCommit });
});

const buildCliTarball = createCliTarballBuilder({ root: env.root, dataDir: env.dataDir });

app.get("/cli.tgz", (_req, res) => {
  try {
    res.type("application/gzip").sendFile(buildCliTarball());
  } catch (error) {
    res.status(500).json({ error: "could not build client bundle" });
  }
});

// One-line installer: `curl -fsSL <hub>/install.sh | bash` (prefix with RUNYARD_HUB_TOKEN=... to auto-login).
app.get("/install.sh", (req, res) => {
  res.type("text/plain").send(installScript(publicUrl(req)));
});

app.get("/", (req, res) => {
  // Authenticated users skip the marketing landing and go straight to the app.
  if (authFromRequest(req)) return res.redirect(302, "/app");
  res.sendFile(path.join(env.root, "public", "landing.html"));
});
app.get("/app", (_req, res) => res.sendFile(path.join(env.root, "public", "index.html")));
app.get("/docs", (_req, res) => res.sendFile(path.join(env.root, "public", "docs.html")));
app.get("/docs/quickstart", (_req, res) => res.sendFile(path.join(env.root, "public", "docs.html")));
app.use("/public", express.static(path.join(env.root, "public")));

// /llms.txt is rendered at request time from hubMenuPayload — the same source
// get_menu returns over MCP — so the tool list and capability catalog can never drift.
app.get("/llms.txt", (req, res) => {
  const menu = hubMenuPayload(req);
  const base = publicUrl(req);
  res.type("text/plain").send(renderLlmsTxt(menu, base));
});

app.get("/openapi.json", (req, res) => {
  res.json(openApiDocument({ baseUrl: publicUrl(req), version: env.version }));
});

app.get("/api/menu", requireAuth, requireScopes("api", "mcp"), (req, res) => {
  res.json(hubMenuPayload(req));
});

app.get("/api/setup", (_req, res) => {
  const telegramTarget = telegramApprovalTarget();
  res.json({
    instanceName: env.instanceName,
    environment: env.environment,
    hostname: env.hostname,
    baseUrl: env.baseUrl,
    auth: "access-token",
    telegramConfigured: Boolean(env.telegramBotToken && telegramTarget),
    telegramApprovalPrivateConfigured: Boolean(env.telegramApprovalChatId),
    telegramApprovalTarget: telegramTarget ? (telegramTarget.private ? "private" : "fallback-chat") : "none",
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

app.post("/api/auth/telegram-webapp", rateLimit({ bucket: "telegram-webapp-login", max: 30, windowMs: 60_000 }), (req, res) => {
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
  const input = tokenCreateInput(req.body || {});
  const token = createAccessToken(input.name, undefined, input.scopes, { expiresAt: input.expiresAt });
  recordAudit(req.token.name, "token.created", token.id, { scopes: input.scopes, expiresAt: input.expiresAt });
  res.json({ token });
});

app.get("/api/audit", requireAuth, requireScopes("admin"), (req, res) => {
  res.json({ audit: listAudit({ limit: Number(req.query.limit || 100) }) });
});

// --- Self-host update: status + apply (admin only) --------------------------
// CHECK (status) is read-only and safe. APPLY is operator-initiated, off over
// HTTP by default (UPDATE_APPLY_ENABLED), and even when on stays admin-gated.
// There is no maintainer phone-home anywhere in this surface.
app.get("/api/update-status", requireAuth, requireScopes("admin"), asyncHandler(async (req, res) => {
  if (req.query.refresh && env.updateCheckEnabled) {
    try {
      await updateChecker.check(true);
    } catch {
      /* check() is already fail-safe; ignore */
    }
  }
  const info = getVersionInfo();
  const cached = updateChecker.getCached();
  res.json({
    current: info.version,
    gitTag: info.gitTag,
    gitCommit: info.gitCommit,
    repo: env.githubRepo,
    enabled: env.updateCheckEnabled,
    applyEnabled: env.updateApplyEnabled,
    latest: cached?.latest || null,
    latestTag: cached?.latestTag || (cached?.latest ? `v${cached.latest}` : null),
    updateAvailable: Boolean(cached?.updateAvailable),
    status: cached?.status || (env.updateCheckEnabled ? "pending" : "disabled"),
    checkedAt: cached?.checkedAt ? new Date(cached.checkedAt).toISOString() : null,
    lastOutcome: latestAlert("update")
  });
}));

app.get("/api/alerts", requireAuth, requireScopes("admin"), (req, res) => {
  res.json({ alerts: listAlerts({ kind: req.query.kind ? String(req.query.kind) : "", limit: Number(req.query.limit || 50) }) });
});

app.post("/api/update/apply", requireAuth, requireScopes("admin"), (req, res) => {
  if (!env.updateApplyEnabled) {
    return res.status(503).json({
      error:
        "HTTP-triggered update is disabled. Run `runyard update` on the host, or set UPDATE_APPLY_ENABLED=1 to enable this button.",
      applyEnabled: false
    });
  }
  // Validate the optional explicit target tag before it is passed as an argv to
  // the update script (never shell-interpolated, but validate defensively).
  const targetTag = typeof req.body?.tag === "string" ? req.body.tag.trim() : "";
  if (targetTag && !/^v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(targetTag)) {
    return res.status(400).json({ error: "invalid target tag" });
  }
  const script = path.join(env.root, "scripts", "runyard-update.sh");
  if (!existsSync(script)) return res.status(500).json({ error: "update script not found on this install" });

  recordAudit(req.token.name, "update.apply", targetTag || "latest", { via: "http" });
  recordAlert({
    kind: "update",
    level: "info",
    title: "Update started",
    message: `${req.token.name} triggered an update to ${targetTag || "latest"} from the Hub UI.`,
    data: { targetTag: targetTag || "latest", by: req.token.name, via: "http" }
  });

  // Launch the updater so it OUTLIVES the imminent restart of THIS very process.
  // A plain detached child stays in this unit's systemd cgroup and would be
  // killed when the script runs `systemctl restart runyard`. So when systemd-run
  // is available we start the updater as a transient unit in ITS OWN cgroup
  // (returns immediately; survives the restart). Otherwise we fall back to a
  // detached spawn (fine for non-systemd boxes). The script also re-execs itself
  // to /tmp before touching the tree, so the code swap can't break it either.
  // The most robust path of all is `runyard update` from an operator shell,
  // which is never in the hub's cgroup — that's what non-applyEnabled hubs tell
  // operators to use.
  const updaterEnv = {
    PATH: process.env.PATH || "",
    RUNYARD_UPDATE_TRIGGER: "http",
    RUNYARD_REPO_DIR: env.root,
    RUNYARD_NODE: process.execPath,
    RUNYARD_DRAIN_GRACE_MS: String(env.drainGraceMs),
    RUNYARD_HUB_DATA_DIR: env.dataDir,
    PORT: String(env.port)
  };
  if (process.env.RUNYARD_UNITS) updaterEnv.RUNYARD_UNITS = process.env.RUNYARD_UNITS;
  if (env.updateNotifyWebhook) updaterEnv.UPDATE_NOTIFY_WEBHOOK = env.updateNotifyWebhook;

  let systemdRun = false;
  try {
    execFileSync("systemd-run", ["--version"], { stdio: "ignore" });
    systemdRun = true;
  } catch {
    systemdRun = false;
  }

  try {
    if (systemdRun) {
      const unit = `runyard-update-${Date.now()}`;
      const setenv = Object.entries(updaterEnv).flatMap(([k, v]) => ["--setenv", `${k}=${v}`]);
      const args = ["--collect", "--quiet", `--unit=${unit}`, ...setenv, "bash", script];
      if (targetTag) args.push(targetTag);
      spawn("systemd-run", args, { stdio: "ignore", detached: true }).unref();
    } else {
      const args = [script];
      if (targetTag) args.push(targetTag);
      spawn("bash", args, { cwd: env.root, detached: true, stdio: "ignore", env: { ...process.env, ...updaterEnv } }).unref();
    }
  } catch (error) {
    return res.status(500).json({ error: `could not start updater: ${error.message}` });
  }
  res.json({ started: true, target: targetTag || "latest", launcher: systemdRun ? "systemd-run" : "spawn" });
});

// --- Encrypted reusable secrets (admin only) --------------------------------
// Names + metadata are listable; values are write-only and never returned. The
// whole feature is disabled (503) unless SECRETS_ENC_KEY is configured, so we
// never silently store plaintext. All routes are admin-scope: a read-scoped
// token gets 403 from requireScopes before reaching the handler.
function requireSecretsEnabled(_req, res, next) {
  if (!secretsEnabled()) {
    const response = secretsDisabledResponse();
    return res.status(response.status).json(response.body);
  }
  next();
}

app.get("/api/secrets", requireAuth, requireScopes("admin"), requireSecretsEnabled, (_req, res) => {
  res.json({ secrets: listSecretMeta(), enabled: true });
});

app.put("/api/secrets/:key", requireAuth, requireScopes("admin"), requireSecretsEnabled, (req, res) => {
  const validated = validateSecretUpsert({ key: req.params.key, value: req.body?.value });
  if (!validated.ok) return res.status(validated.status).json(validated.body);
  const { key, value } = validated;
  const created = !secretExists(key);
  const meta = upsertSecret({ key, value, description: String(req.body?.description || ""), createdBy: secretActorName(req.token) });
  // Audit records the key + actor only — never the value.
  recordAudit(req.token.name, created ? "secret.created" : "secret.updated", key, { key });
  res.status(created ? 201 : 200).json({ secret: meta });
});

app.delete("/api/secrets/:key", requireAuth, requireScopes("admin"), requireSecretsEnabled, (req, res) => {
  const key = String(req.params.key || "").trim();
  if (!secretExists(key)) return res.status(404).json({ error: "secret not found" });
  deleteSecret(key);
  recordAudit(req.token.name, "secret.deleted", key, { key });
  res.json({ ok: true, key });
});

app.get("/api/workflow-endpoints", requireAuth, requireScopes("admin"), (req, res) => {
  const includeDisabled = req.query.all === "1";
  res.json({ endpoints: listWorkflowEndpoints({ includeDisabled }) });
});

app.post("/api/workflow-endpoints", requireAuth, requireScopes("admin"), (req, res) => {
  try {
    const endpoint = upsertWorkflowEndpoint(
      {
        ...req.body,
        slug: requireBodySlug(req.body, "workflow-endpoint"),
        capabilitySlug: req.body.capabilitySlug || req.body.capability_slug || "improve-no-deploy"
      },
      req.body.secret || req.body.apiKey || req.body.token ? { secret: req.body.secret || req.body.apiKey || req.body.token } : {}
    );
    recordAudit(req.token.name, "workflow_endpoint.upserted", endpoint.id, { endpointSlug: endpoint.slug, capabilitySlug: endpoint.capabilitySlug });
    res.json({ endpoint });
  } catch (error) {
    res.status(400).json({ error: error.message || "invalid workflow endpoint" });
  }
});

app.get("/api/workflow-endpoints/:endpointSlug", requireAuth, requireScopes("admin"), (req, res) => {
  const endpoint = getWorkflowEndpoint(req.params.endpointSlug, { includeDisabled: true });
  if (!endpoint) return res.status(404).json({ error: "workflow endpoint not found" });
  res.json({ endpoint });
});

app.post("/api/workflow-endpoints/:endpointSlug", asyncHandler(async (req, res) => {
  const endpoint = getWorkflowEndpoint(req.params.endpointSlug, { includeSecretHash: true });
  const presented = bearerFromRequest(req) || String(req.headers["x-smithers-endpoint-secret"] || "").trim();
  if (!endpoint || !presented || !timingSafeEqualStr(hashToken(presented), endpoint.secretHash)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const sizeBytes = bodySizeBytes(req);
  if (sizeBytes > endpoint.maxPayloadBytes) {
    recordAudit(`workflow-endpoint:${endpoint.slug}`, "workflow_endpoint.payload_too_large", endpoint.id, {
      endpointSlug: endpoint.slug,
      sizeBytes,
      maxPayloadBytes: endpoint.maxPayloadBytes
    });
    return res.status(413).json({ error: "payload too large", maxPayloadBytes: endpoint.maxPayloadBytes });
  }

  const payloadHash = workflowEndpointPayloadHash(req.body || {});
  const built = workflowEndpointRunInput(endpoint, req.body || {}, { payloadHash });
  if (!built.ok) return res.status(built.code).json({ error: built.error });

  const rateSince = new Date(Date.now() - endpoint.rateLimitWindowMs).toISOString();
  const recentCount = countWorkflowEndpointInvocations(endpoint.id, rateSince);
  if (recentCount >= endpoint.rateLimitCount) {
    recordAudit(`workflow-endpoint:${endpoint.slug}`, "workflow_endpoint.rate_limited", endpoint.id, {
      endpointSlug: endpoint.slug,
      payloadHash,
      source: built.source
    });
    res.setHeader("retry-after", Math.ceil(endpoint.rateLimitWindowMs / 1000));
    return res.status(429).json({ error: "too many requests" });
  }

  if (endpoint.dedupeWindowMs > 0) {
    const dedupeSince = new Date(Date.now() - endpoint.dedupeWindowMs).toISOString();
    const recent = findRecentWorkflowEndpointInvocation(endpoint.id, payloadHash, dedupeSince);
    if (recent) {
      const run = getRun(recent.runId);
      recordWorkflowEndpointInvocation({ endpoint, payloadHash, source: built.source, runId: recent.runId, status: "deduped" });
      recordAudit(`workflow-endpoint:${endpoint.slug}`, "workflow_endpoint.deduped", recent.runId, {
        endpointSlug: endpoint.slug,
        runId: recent.runId,
        payloadHash,
        source: built.source
      });
      return res.status(202).json({
        endpoint: { slug: endpoint.slug },
        deduped: true,
        run: run ? withRunLinks(run) : null,
        statusUrl: `/api/runs/${recent.runId}`,
        webUrl: `/app#runs/${recent.runId}`,
        deepLink: deepLinks.run(recent.runId)
      });
    }
  }

  const capability = getCapability(endpoint.capabilitySlug);
  if (!capability || !capability.enabled) {
    recordAudit(`workflow-endpoint:${endpoint.slug}`, "workflow_endpoint.misconfigured", endpoint.id, {
      endpointSlug: endpoint.slug,
      capabilitySlug: endpoint.capabilitySlug,
      payloadHash
    });
    return res.status(500).json({ error: "workflow endpoint is misconfigured" });
  }

  const run = createRun(capability, built.input, {
    requestedBy: `workflow-endpoint: ${endpoint.slug}`,
    origin: {
      label: `workflow endpoint: ${endpoint.slug}`,
      type: "workflow-endpoint",
      endpointSlug: endpoint.slug,
      app: built.source.app,
      user: built.source.user,
      session: built.source.session,
      payloadHash
    }
  });
  recordWorkflowEndpointInvocation({ endpoint, payloadHash, source: built.source, runId: run.id, status: "queued" });
  addRunEvent(run.id, "workflow_endpoint.queued", `Queued by workflow endpoint ${endpoint.slug}`, {
    endpointSlug: endpoint.slug,
    payloadHash,
    source: built.source
  });
  recordAudit(`workflow-endpoint:${endpoint.slug}`, "workflow_endpoint.queued", run.id, {
    endpointSlug: endpoint.slug,
    runId: run.id,
    capabilitySlug: capability.slug,
    payloadHash,
    source: built.source,
    sizeBytes
  });
  res.status(202).json({
    endpoint: { slug: endpoint.slug },
    deduped: false,
    run: withRunLinks(run),
    statusUrl: `/api/runs/${run.id}`,
    logsUrl: `/api/runs/${run.id}/logs`,
    artifactsUrl: `/api/runs/${run.id}/artifacts`,
    outputsLocation: "hub",
    artifactsLocation: "hub",
    webUrl: `/app#runs/${run.id}`,
    deepLink: deepLinks.run(run.id),
    payloadHash
  });
}));

app.delete("/api/tokens/:id", requireAuth, requireScopes("admin"), (req, res) => {
  const tokens = listAccessTokens();
  const decision = revokeTokenDecision(tokens, req.params.id);
  if (!decision.ok) return res.status(decision.status).json(decision.body);
  const revoked = revokeAccessToken(req.params.id);
  recordAudit(req.token.name, "token.revoked", req.params.id, {});
  res.json({ token: revoked });
});

app.get("/api/dashboard", requireAuth, (_req, res) => {
  const recent = listRuns({ limit: 8 });
  const queueIndex = buildQueueIndex(listRuns({ status: "queued", limit: 500 }));
  res.json({
    stats: dashboardStats(),
    pool: runnerPoolStats(),
    recentRuns: recent.map((run) => withRunLinks(run, queueIndex)),
    pendingApprovals: listApprovals("pending").map(withApprovalLinks)
  });
});

app.get("/api/capabilities", requireAuth, (req, res) => {
  // Catalog shows enabled capabilities; admins can include disabled with ?all=1.
  const includeDisabled = req.query.all === "1" && (req.token.scopes || []).includes("admin");
  res.json({ capabilities: listCapabilities({ q: req.query.q || "", includeDisabled }).map(withCapabilityLinks) });
});

app.post("/api/capabilities", requireAuth, requireScopes("admin"), (req, res) => {
  const body = { ...req.body, slug: requireBodySlug(req.body, "capability") };
  res.json({ capability: upsertCapability(body) });
});

app.get("/api/capabilities/:id", requireAuth, (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability) return res.status(404).json({ error: "capability not found" });
  res.json({ capability: withCapabilityLinks(capability) });
});

// Distinct capability_sha values observed across this capability's runs —
// the source-of-truth list for "what can I roll back to?". Empty unless
// RUNYARD_CAPABILITY_VERSIONING has been enabled at least once and runs were
// recorded with a non-null sha. We intentionally derive from the runs table
// (not the existing `capability_versions` snapshot table, which tracks
// in-DB capability config bumps and is unrelated to git SHAs).
app.get("/api/capabilities/:name/versions", requireAuth, (req, res) => {
  const capability = getCapability(req.params.name);
  if (!capability) return res.status(404).json({ error: "capability not found" });
  res.json({
    capability: { slug: capability.slug, name: capability.name },
    versioningEnabled: capabilityVersioningEnabled(process.env),
    versions: listCapabilityVersionsFromRuns(capability.slug)
  });
});

// --- Workflow source + graph ------------------------------------------------
// Serves the actual workflow code (the source-of-truth template authored in
// `workflow-templates/workflows/<slug>.tsx`) together with a parsed metadata
// header and a first-pass workflow graph derived from the JSX structure. The
// Hub code viewer and the ReactFlow visualizer both consume this endpoint —
// Smithers source remains the source of truth and the canvas is a renderer.
app.get("/api/capabilities/:id/source", requireAuth, (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability) return res.status(404).json({ error: "capability not found" });
  const source = loadWorkflowSource(capability, { root: env.root });
  if (!source) {
    return res.json({
      slug: capability.slug,
      available: false,
      capability: withCapabilityLinks(capability),
      message: "No workflow source file shipped for this capability. The graph below is derived from registered metadata only.",
      graph: deriveWorkflowGraphFromMetadata(capability)
    });
  }
  const metadata = parseWorkflowMetadata(source.code);
  const sections = sliceWorkflowSections(source.code);
  const graph = deriveWorkflowGraph(source.code, capability);
  res.json({
    slug: capability.slug,
    available: true,
    capability: withCapabilityLinks(capability),
    path: source.relativePath,
    language: source.language,
    sizeBytes: source.code.length,
    metadata,
    sections,
    code: source.code,
    graph
  });
});

app.patch("/api/capabilities/:id", requireAuth, requireScopes("admin"), (req, res) => {
  const existing = getCapability(req.params.id);
  if (!existing) return res.status(404).json({ error: "capability not found" });
  res.json({ capability: upsertCapability({ ...existing, ...req.body, slug: existing.slug }) });
});

app.post("/api/capabilities/:id/run", requireAuth, requireScopes("api", "mcp"), asyncHandler(async (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability || !capability.enabled) return res.status(404).json({ error: "capability not found" });
  // Admin-only capabilities (e.g. reauth-cli, which drives a CLI login on the
  // runner host) can only be triggered by an admin token. The flag rides in the
  // capability's workflow JSON so it is part of the definition hash.
  if (capability.workflow?.adminOnly && !(req.token?.scopes || []).includes("admin")) {
    return res.status(403).json({ error: "admin scope required", capability: capability.slug });
  }
  // Optional per-run response endpoint (slice 1 of the response-egress
  // contract). Validate the caller-supplied shape BEFORE the run is created
  // so a malformed endpoint fails 400 cleanly and never produces an orphan
  // run. See specs/run-response-endpoints.md.
  const responseEndpointResult = parseResponseEndpoint(req.body.responseEndpoint);
  if (!responseEndpointResult.ok) return res.status(400).json({ error: responseEndpointResult.error });
  const input = req.body.input || req.body || {};
  // Defense in depth: when the caller posts `{ responseEndpoint: ... }` without
  // an `input` wrapper, the fallback above aliases `input` to the request body
  // — which would otherwise dump the raw endpoint config (bearer headers and
  // all) into the stored run input. Strip it here so the endpoint only ever
  // lives in `run_response_endpoints`.
  if (input && typeof input === "object" && !Array.isArray(input) && "responseEndpoint" in input) {
    delete input.responseEndpoint;
  }
  attachChainToInput(input, req.body.chain);
  const execution = normalizeExecutionIntent(input, req.body || {});
  const origin = requestOrigin(req, input);
  // Capability version pinning + rollback (RUNYARD_CAPABILITY_VERSIONING).
  // We resolve the ref here so an explicit `pin` (e.g. CLI `--pin <sha>` or
  // `capability rollback`) overrides the workspace HEAD; without the flag
  // both values resolve to null and the legacy path is unchanged.
  const { capabilitySha: resolvedSha } = resolveCapabilityRef(capability, {
    pin: req.body.pin,
    env: process.env
  });
  const versionOptions = resolveCapabilityVersionOptions(
    { capabilitySha: req.body.pin || resolvedSha, parentRunId: req.body.parentRunId },
    process.env
  );
  const dispatched = dispatchRun(capability, input, {
    runnerId: req.body.runnerId,
    requestedBy: origin.requestedBy,
    origin: origin.origin,
    execution,
    capabilitySha: versionOptions.capabilitySha,
    parentRunId: versionOptions.parentRunId
  });
  const run = dispatched.run;
  // Persist the validated endpoint in its own table — never write the raw
  // config into the run's input where it would leak through workflow events
  // and audit detail. TODO(slice 2): wire up actual outbound delivery from
  // the terminal-state transition hooks.
  let registeredResponseEndpoint = null;
  if (responseEndpointResult.value) {
    const stored = createRunResponseEndpoint({
      runId: run.id,
      type: responseEndpointResult.value.type,
      config: responseEndpointResult.value.config,
      createdBy: req.token?.name || req.token?.id || ""
    });
    registeredResponseEndpoint = presentRunResponseEndpoint(stored);
    const auditDetail = safeResponseEndpointAuditDetail(stored);
    addRunEvent(
      run.id,
      "run.response_endpoint.registered",
      `Response endpoint registered (${stored.type})`,
      auditDetail
    );
    recordAudit(origin.requestedBy, "run.response_endpoint.registered", run.id, {
      runId: run.id,
      ...auditDetail
    });
  }
  const pending = listApprovals("pending").find((approval) => approval.runId === run.id);
  if (pending) await notifyTelegram(pending);
  res.status(202).json({
    run: withRunLinks(run),
    ...(dispatched.supervising ? { supervising: dispatched.supervising } : {}),
    ...(dispatched.supervisedChild ? { supervisedChild: dispatched.supervisedChild } : {}),
    ...(registeredResponseEndpoint ? { responseEndpoint: registeredResponseEndpoint } : {}),
    statusUrl: `/api/runs/${run.id}`,
    logsUrl: `/api/runs/${run.id}/logs`,
    artifactsUrl: `/api/runs/${run.id}/artifacts`,
    outputsLocation: "hub",
    artifactsLocation: "hub",
    webUrl: `/app#runs/${run.id}`,
    deepLink: deepLinks.run(run.id),
    deepLinkLogs: deepLinks.runLogs(run.id),
    deepLinkArtifacts: deepLinks.runArtifacts(run.id)
  });
}));

// Curated repo/project catalog for the Run form's repo picker. Returns only
// operator-configured friendly selector keys + a default Hub entry — never raw
// runner-local paths, secrets, or a filesystem scan. See src/repoCatalog.js.
app.get("/api/repo-options", requireAuth, (_req, res) => {
  res.json(buildRepoCatalog(process.env));
});

// --- Schedules (cron jobs) --------------------------------------------------
// Operators schedule recurring (cron) or one-shot (runAt) runs of a capability.
// Firing goes through the same dispatchRun() choke point as a manual run, so a
// scheduled run honors the capability's approval policy and supervision
// envelope — a schedule can never escalate past what a manual run of the same
// capability would do. The created run's origin records the schedule + creator
// for audit. See src/cron.js (parser) and src/db.js (storage + idempotent claim).

// Fire a single schedule: create a run via the shared dispatch path and record
// the outcome on the schedule row + audit log. Does NOT advance next_run_at
// (claimScheduleFire owns that). Returns { ok, run } or { ok:false, error }.
function runScheduleNow(schedule, { trigger = "manual", actor = "" } = {}) {
  const capability = getCapability(schedule.capabilitySlug);
  if (!capability || !capability.enabled) {
    return { ok: false, error: `capability "${schedule.capabilitySlug}" is unavailable` };
  }
  const input = schedule.input && typeof schedule.input === "object" && !Array.isArray(schedule.input)
    ? { ...schedule.input }
    : {};
  const requestedBy = `schedule: ${schedule.name}`;
  const origin = {
    type: "schedule",
    label: `schedule: ${schedule.name}`,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    trigger
  };
  const dispatched = dispatchRun(capability, input, { requestedBy, origin });
  const runRecord = dispatched.run;
  addRunEvent(runRecord.id, "run.scheduled", `Created by schedule "${schedule.name}"`, {
    scheduleId: schedule.id,
    cron: schedule.cron || "",
    timezone: schedule.timezone,
    trigger
  });
  recordScheduleFireResult(schedule.id, runRecord.id, runRecord.status);
  recordAudit(actor || requestedBy, "schedule.fired", schedule.id, {
    runId: runRecord.id,
    capability: schedule.capabilitySlug,
    trigger
  });
  return { ok: true, run: runRecord, dispatched };
}

// Evaluate all due schedules and fire each exactly once. Safe to call from the
// ticker on every tick (idempotent via claimScheduleFire) and from tests.
function fireDueSchedules(nowIso = now()) {
  const due = listDueSchedules(nowIso);
  const firedRunIds = [];
  for (const schedule of due) {
    try {
      const claim = claimScheduleFire(schedule.id, schedule.nextRunAt, nowIso);
      if (!claim.ok) continue; // already fired this tick, raced, or disabled
      const result = runScheduleNow(schedule, { trigger: "ticker", actor: `schedule:${schedule.id}` });
      if (result.ok) {
        firedRunIds.push(result.run.id);
        const pending = listApprovals("pending").find((approval) => approval.runId === result.run.id);
        if (pending) notifyTelegram(pending).catch(() => {});
      } else {
        recordScheduleFireResult(schedule.id, null, `error: ${result.error}`.slice(0, 80));
        recordAudit(`schedule:${schedule.id}`, "schedule.fire_failed", schedule.id, { error: result.error });
      }
    } catch (error) {
      recordAudit(`schedule:${schedule.id}`, "schedule.fire_failed", schedule.id, { error: error.message });
    }
  }
  return firedRunIds;
}

app.get("/api/schedules", requireAuth, (_req, res) => {
  res.json({ schedules: listSchedules().map(withScheduleView) });
});

// Validate a cron expression (and optional timezone) and return a description +
// the next few fire times. Powers the live preview in the Schedules form.
app.get("/api/schedules/preview", requireAuth, (req, res) => {
  const cron = String(req.query.cron || "").trim();
  const timezone = String(req.query.timezone || "UTC").trim() || "UTC";
  const preview = schedulePreview(cron, timezone);
  if (!preview.ok) return res.status(preview.status).json({ error: preview.error });
  res.json(preview.value);
});

app.get("/api/schedules/:id", requireAuth, (req, res) => {
  const schedule = getSchedule(req.params.id);
  if (!schedule) return res.status(404).json({ error: "schedule not found" });
  res.json({ schedule: withScheduleView(schedule) });
});

app.post("/api/schedules", requireAuth, requireScopes("admin"), (req, res) => {
  const validated = validateScheduleBody(req.body || {}, { partial: false, getCapability });
  if (!validated.ok) return res.status(400).json({ error: validated.error });
  const schedule = createSchedule({
    ...validated.value,
    createdBy: req.token?.name || req.token?.id || ""
  });
  recordAudit(req.token.name, "schedule.created", schedule.id, {
    capability: schedule.capabilitySlug,
    cron: schedule.cron || "",
    runAt: schedule.runAt || ""
  });
  res.status(201).json({ schedule: withScheduleView(schedule) });
});

app.patch("/api/schedules/:id", requireAuth, requireScopes("admin"), (req, res) => {
  const existing = getSchedule(req.params.id);
  if (!existing) return res.status(404).json({ error: "schedule not found" });
  const validated = validateScheduleBody(req.body || {}, { partial: true, getCapability });
  if (!validated.ok) return res.status(400).json({ error: validated.error });
  const schedule = updateSchedule(req.params.id, validated.value);
  recordAudit(req.token.name, "schedule.updated", schedule.id, { fields: Object.keys(validated.value) });
  res.json({ schedule: withScheduleView(schedule) });
});

app.post("/api/schedules/:id/enable", requireAuth, requireScopes("admin"), (req, res) => {
  if (!getSchedule(req.params.id)) return res.status(404).json({ error: "schedule not found" });
  const schedule = setScheduleEnabled(req.params.id, true);
  recordAudit(req.token.name, "schedule.enabled", schedule.id, {});
  res.json({ schedule: withScheduleView(schedule) });
});

app.post("/api/schedules/:id/disable", requireAuth, requireScopes("admin"), (req, res) => {
  if (!getSchedule(req.params.id)) return res.status(404).json({ error: "schedule not found" });
  const schedule = setScheduleEnabled(req.params.id, false);
  recordAudit(req.token.name, "schedule.disabled", schedule.id, {});
  res.json({ schedule: withScheduleView(schedule) });
});

app.delete("/api/schedules/:id", requireAuth, requireScopes("admin"), (req, res) => {
  const deleted = deleteSchedule(req.params.id);
  if (!deleted) return res.status(404).json({ error: "schedule not found" });
  recordAudit(req.token.name, "schedule.deleted", req.params.id, { name: deleted.name });
  res.json({ deleted: true, schedule: withScheduleView(deleted) });
});

// Fire a schedule immediately without disturbing its cron cadence (next_run_at
// is left untouched). Requires run scope since it creates a real run.
app.post(
  "/api/schedules/:id/run-now",
  requireAuth,
  requireScopes("api", "mcp", "admin"),
  rateLimit({ bucket: "schedule-run-now", max: 60, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const schedule = getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: "schedule not found" });
    const result = runScheduleNow(schedule, { trigger: "manual", actor: req.token?.name || req.token?.id || "" });
    if (!result.ok) return res.status(409).json({ error: result.error });
    const pending = listApprovals("pending").find((approval) => approval.runId === result.run.id);
    if (pending) await notifyTelegram(pending);
    res.status(202).json({
      run: withRunLinks(result.run),
      ...(result.dispatched.supervising ? { supervising: result.dispatched.supervising } : {}),
      schedule: withScheduleView(getSchedule(req.params.id)),
      statusUrl: `/api/runs/${result.run.id}`,
      deepLink: deepLinks.run(result.run.id)
    });
  })
);

app.get("/api/agents", requireAuth, (req, res) => res.json({ agents: listAgents(req.query.q || "").map(withAgentLinks) }));
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
  reapStuckRunsWithRetrospectives(env.runDeadlineMs);
  const status = req.query.status || "";
  const limit = Math.min(Number(req.query.limit || 100), 500);
  // Optional workflow filter. `capability` / `capabilitySlug` are the legacy
  // single-workflow aliases; `workflows` / `capabilities` accept comma-separated
  // slugs for the Runs page multi-check filter.
  const capability = String(req.query.capability || req.query.capabilitySlug || "").trim();
  const hasWorkflowParam = Object.hasOwn(req.query, "workflows") || Object.hasOwn(req.query, "capabilities");
  const workflowParam = hasWorkflowParam ? String(req.query.workflows || req.query.capabilities || "").trim() : "";
  const workflowSlugs = [
    ...new Set(
      [
        ...workflowParam.split(","),
        capability
      ].map((slug) => String(slug || "").trim()).filter(Boolean)
    )
  ];
  const includeInternal = workflowSlugs.some((slug) => DEFAULT_HIDDEN_RUN_SLUGS.includes(slug));
  const explicitEmptyWorkflowFilter = hasWorkflowParam && !capability && workflowSlugs.length === 0;
  const capabilitySlugs = explicitEmptyWorkflowFilter ? ["__runyard-no-workflow__"] : workflowSlugs;
  // Optional text query (matches workflow name/slug, run id, step, error) and
  // ISO time range. Cursor pagination is the createdAt of the last row from
  // the previous page; clients pass it back verbatim to fetch the next slice.
  const q = String(req.query.q || "").trim();
  const since = String(req.query.since || "").trim();
  const until = String(req.query.until || "").trim();
  const cursor = String(req.query.cursor || "").trim();
  const filters = { status, q, since, until, capabilitySlugs, includeInternal };
  const filtered = Boolean(q || since || until || cursor || workflowSlugs.length || explicitEmptyWorkflowFilter);
  let rows;
  let total;
  let nextCursor = null;
  if (filtered) {
    // Over-fetch by one to detect whether another page exists.
    const page = listRuns({ ...filters, cursor, limit: limit + 1 });
    if (page.length > limit) {
      rows = page.slice(0, limit);
      nextCursor = rows[rows.length - 1].createdAt;
    } else {
      rows = page;
    }
    total = countRuns(filters);
  } else {
    rows = listRuns({ status, limit });
    total = countRuns({ status });
  }
  // Queue position is computed against the global queued backlog (not the
  // filtered page) so the chip "in queue · 3 of 7" stays accurate regardless
  // of how the caller slices the list.
  const queueIndex = buildQueueIndex(status === "queued" && !filtered ? rows : listRuns({ status: "queued", limit: 500 }));
  res.json({
    runs: rows.map((run) => withRunLinks(run, queueIndex)),
    total,
    limit,
    nextCursor,
    pool: runnerPoolStats(),
    ...(capability ? { capability } : {}),
    ...(workflowSlugs.length ? { workflows: workflowSlugs } : {}),
    ...(filtered ? { filters: { q, status, since, until, cursor, workflows: workflowSlugs } } : {})
  });
});
app.get("/api/runs/:id", requireAuth, (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  const events = listRunEvents(run.id);
  const artifacts = listArtifacts({ runId: run.id }).map(withArtifactLinks);
  // Surface attached response endpoints as the redacted summary only — raw
  // bearer tokens, header values, and chat ids stay server-side.
  const responseEndpoints = listRunResponseEndpointsForRun(run.id).map(presentRunResponseEndpoint);
  res.json({
    run: decorateSingleRun(run),
    events,
    artifacts,
    responseEndpoints,
    diagnostics: runDiagnostics(run, events, artifacts),
    logSummary: summarizeRunEvents(events),
    pool: runnerPoolStats()
  });
});
app.get("/api/runs/:id/events", requireAuth, (req, res) => res.json({ events: listRunEvents(req.params.id) }));
// Live event stream (Server-Sent Events). Additive companion to the REST
// endpoints above — the React run-detail console tails this and falls back to
// polling /api/runs/:id/events if the stream is unavailable or drops. Cookie
// auth flows through requireAuth automatically (EventSource sends same-origin
// cookies), so no header juggling is needed.
app.get("/api/runs/:id/events/stream", requireAuth, (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Defeat proxy buffering (nginx) so events flush immediately.
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();
  // Opening comment + a "ready" frame carrying the last known event id so the
  // client can reconcile against its initial fetch without missing events.
  res.write(": connected\n\n");
  const existing = listRunEvents(run.id);
  const lastId = existing.length ? existing[existing.length - 1].id : null;
  res.write(`event: ready\ndata: ${JSON.stringify({ runId: run.id, lastEventId: lastId, count: existing.length })}\n\n`);

  const send = (event) => {
    try {
      res.write(`event: run-event\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Write after close — cleanup below handles teardown.
    }
  };
  const unsubscribe = subscribeRunEvents(run.id, send);
  // Heartbeat comment keeps idle connections alive through proxy timeouts.
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 25_000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
});
app.get("/api/runs/:id/log-summary", requireAuth, (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json({ run: withRunLinks(run), logSummary: summarizeRunEvents(listRunEvents(run.id)) });
});
app.get("/api/runs/:id/diagnostics", requireAuth, (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  const events = listRunEvents(run.id);
  const artifacts = listArtifacts({ runId: run.id }).map(withArtifactLinks);
  res.json({
    run: withRunLinks(run),
    diagnostics: runDiagnostics(run, events, artifacts),
    logSummary: summarizeRunEvents(events)
  });
});
app.get("/api/runs/:id/logs", requireAuth, (req, res) => {
  // Apply the same redaction pass we use for diagnostics so any token-shaped
  // payload that leaked into a log message stays redacted on the wire too.
  const logs = listRunEvents(req.params.id)
    .map((event) => `[${event.createdAt}] ${event.type}: ${redactSnippet(event.message, 4000)}`)
    .join("\n");
  res.type("text/plain").send(logs);
});

// Unified run timeline (feature-flagged by RUNYARD_RUN_TIMELINE). Merges the
// four existing sources of per-run truth — runs row status transitions, run
// events, runner artifacts, and the two generated terminal artifacts
// (retrospective + obstruction analysis) — into a single ascending stream of
// `{ts, kind, source, payload}` rows. The endpoint reuses the existing DB
// and artifact helpers; no new storage is introduced. Auth is the unchanged
// scoped-token `requireAuth` middleware. `since` is exclusive (ts > since)
// and `limit` is clamped to 1000 to keep payloads bounded for tail clients.
app.get("/api/runs/:id/timeline", requireAuth, (req, res) => {
  if (!env.runTimelineEnabled) return res.status(404).json({ error: "run timeline disabled" });
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  const since = String(req.query.since || "").trim();
  const limitRaw = Number(req.query.limit);
  const sorted = buildRunTimeline(run, {
    events: listRunEvents(run.id),
    artifacts: listArtifacts({ runId: run.id }),
    withArtifactLinks
  });
  const page = timelinePage(sorted, { since, limit: limitRaw });
  res.json({
    runId: run.id,
    ...page
  });
});
app.post("/api/runs/:id/events", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  // Scrub any injected secret value out of the event message/data before it is
  // persisted — an event firehose is the easiest place for a secret to leak.
  const message = scrubStoredSecrets(req.body.message || "");
  const data = scrubStoredSecrets(req.body.data || {});
  const event = addRunEvent(req.params.id, req.body.type || "log", message, data);
  if (req.body.type === "workflow.step") updateRun(req.params.id, { current_step: message });
  res.json({ event });
});
app.post("/api/runs/:id/start", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const result = transitionRun(req.params.id, "running", { current_step: "running", started_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (!result.idempotent) addRunEvent(req.params.id, "run.started", "Run started");
  res.json({ run: result.run });
});

function queueNextChainedRun(parentRun, output, req) {
  const { chain, index } = chainMetadata(parentRun.input || {});
  const next = chain[index];
  if (!next) {
    if (chain.length > 0) addRunEvent(parentRun.id, "run.chain.completed", "Workflow chain completed", { chainLength: chain.length });
    return null;
  }
  const capability = getCapability(next.capability);
  if (!capability || !capability.enabled) {
    addRunEvent(parentRun.id, "run.chain.failed", `Next chained capability not found: ${next.capability}`, { capability: next.capability, index });
    return null;
  }
  const nextInput = nextChainedRunInput({ parentRun, output, chain, index, next });
  const origin = requestOrigin(req, {
    origin: nextChainedRunOrigin(parentRun, chain, index)
  });
  const child = createRun(capability, nextInput, {
    requestedBy: origin.requestedBy || "workflow-chain",
    origin: origin.origin,
    execution: executionIntentFromInput(parentRun.input || {})
  });
  addRunEvent(parentRun.id, "run.chain.queued", `Queued chained run ${child.id} for ${capability.name}`, {
    childRunId: child.id,
    capability: capability.slug,
    index: index + 1,
    deepLink: deepLinks.run(child.id)
  });
  addRunEvent(child.id, "run.chain.parent", `Created from parent run ${parentRun.id}`, {
    parentRunId: parentRun.id,
    parentCapability: parentRun.capabilitySlug,
    index: index + 1,
    deepLink: deepLinks.run(parentRun.id)
  });
  return child;
}

function maybeRecordFailureClassAlert(status) {
  return maybeRecordFailureAlert(status, { countRuns, latestAlert, recordAlert });
}

app.post("/api/runs/:id/complete", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  // Scrub injected secret values out of the run output before it is persisted
  // or echoed back through any read API.
  const output = scrubStoredSecrets(req.body.output || {});
  const result = transitionRun(req.params.id, "succeeded", { current_step: "completed", output, completed_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (result.raced) {
    addRunEvent(req.params.id, "run.transition_ignored", `Ignored late 'succeeded' report; run already terminal as '${result.run.status}'`, { attempted: "succeeded", terminal: result.run.status });
  }
  if (!result.idempotent) addRunEvent(req.params.id, "run.succeeded", "Run completed");
  const chainedRun = result.idempotent ? null : queueNextChainedRun(result.run, output, req);
  if (!result.idempotent) recordRunTerminalArtifacts(result.run.id);
  res.json({ run: result.run, chainedRun: chainedRun ? withRunLinks(chainedRun) : null });
});
app.post("/api/runs/:id/fail", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const error = scrubStoredSecrets(req.body.error || "failed");
  const status = normalizeFailureStatus(req.body.status || classifyFailureStatus(error));
  const result = transitionRun(req.params.id, status, { current_step: status, error, completed_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (result.raced) {
    addRunEvent(req.params.id, "run.transition_ignored", `Ignored late '${status}' report; run already terminal as '${result.run.status}'`, { attempted: status, terminal: result.run.status });
  }
  if (!result.idempotent) addRunEvent(req.params.id, failureEventType(status), error || `Run ended as ${status}`, { failureClass: status });
  if (!result.idempotent) maybeRecordFailureClassAlert(status);
  if (!result.idempotent) recordRunTerminalArtifacts(result.run.id);
  res.json({ run: result.run });
});
app.post("/api/runs/:id/cancel", requireAuth, requireScopes("api", "mcp", "runner"), (req, res) => {
  const result = transitionRun(req.params.id, "cancelled", { current_step: "cancelled", completed_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (!result.idempotent) addRunEvent(req.params.id, "run.cancelled", req.body.reason || "Run cancelled");
  if (!result.idempotent) recordRunTerminalArtifacts(result.run.id);
  res.json({ run: result.run });
});

app.post("/api/runs/:id/rerun", requireAuth, requireScopes("api", "mcp"), asyncHandler(async (req, res) => {
  const previous = getRun(req.params.id);
  if (!previous) return res.status(404).json({ error: "run not found" });
  const previousPresented = withRunLinks(previous);
  const capability = getCapability(previousPresented.capabilitySlug);
  if (!capability || !capability.enabled) return res.status(404).json({ error: "capability not found" });
  const editedInput = req.body?.input && typeof req.body.input === "object" && !Array.isArray(req.body.input) ? req.body.input : null;
  const baseInput = editedInput || previousPresented.input;
  const input = cleanRerunInput(baseInput, previous.id);
  const force = req.body?.force === true;
  if (!force) {
    const existing = findActiveDuplicateRerun({ previousRunId: previous.id, capabilitySlug: capability.slug, input });
    if (existing) {
      addRunEvent(previous.id, "run.rerun_deduped", `Duplicate re-run reused ${existing.id}`, { runId: existing.id });
      return res.status(202).json({
        deduped: true,
        run: withRunLinks(existing),
        previousRun: withRunLinks(previous),
        statusUrl: `/api/runs/${existing.id}`,
        webUrl: `/app#runs/${existing.id}`,
        deepLink: deepLinks.run(existing.id)
      });
    }
  }
  const origin = requestOrigin(req, {
    ...input,
    origin: {
      label: `Re-run from Hub of ${previous.id}`,
      type: "hub-rerun",
      previousRunId: previous.id
    }
  });
  const dispatched = dispatchRun(capability, input, {
    requestedBy: origin.requestedBy,
    origin: origin.origin
  });
  const run = dispatched.run;
  addRunEvent(previous.id, "run.rerun_requested", `Re-run requested as ${run.id}`, { runId: run.id });
  addRunEvent(run.id, "run.rerun_of", `Re-run of ${previous.id}`, { previousRunId: previous.id });
  const pending = listApprovals("pending").find((approval) => approval.runId === run.id);
  if (pending) await notifyTelegram(pending);
  res.status(202).json({
    run: withRunLinks(run),
    ...(dispatched.supervising ? { supervising: dispatched.supervising } : {}),
    ...(dispatched.supervisedChild ? { supervisedChild: dispatched.supervisedChild } : {}),
    previousRun: withRunLinks(previous),
    statusUrl: `/api/runs/${run.id}`,
    webUrl: `/app#runs/${run.id}`,
    deepLink: deepLinks.run(run.id)
  });
}));

app.get("/api/runs/:id/artifacts", requireAuth, (req, res) => res.json({ artifacts: listArtifacts({ runId: req.params.id }).map(withArtifactLinks) }));
app.post("/api/runs/:id/artifacts", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const runRecord = getRun(req.params.id);
  if (!runRecord) return res.status(404).json({ error: "run not found" });
  const artifact = storeRunArtifact(runRecord, req.body);
  res.json({ artifact });
});

app.get("/api/artifacts", requireAuth, (req, res) => res.json({ artifacts: listArtifacts({ q: req.query.q || "" }).map(withArtifactLinks) }));
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

app.get("/api/approvals", requireAuth, (req, res) => res.json({ approvals: listApprovals(req.query.status || "").map(withApprovalLinks) }));
app.get("/api/approvals/:id", requireAuth, (req, res) => {
  const approval = getApproval(req.params.id);
  if (!approval) return res.status(404).json({ error: "approval not found" });
  res.json({ approval: withApprovalLinks(approval) });
});
function findExistingChildRunApproval(payload = {}) {
  return findMatchingChildRunApproval(listApprovals("pending"), payload);
}

app.post("/api/approvals", requireAuth, requireScopes("api", "mcp", "runner", "approvals"), asyncHandler(async (req, res) => {
  try {
    const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {};
    const existing = findExistingChildRunApproval(payload);
    if (existing) return res.status(200).json({ approval: withApprovalLinks(existing), idempotent: true });

    // Only link the approval to a run row that actually exists. A child approval
    // can reference a run id the Hub can't see (a not-yet-persisted or already-
    // pruned child); inserting that id would violate the runs foreign key and —
    // before this guard — threw an unhandled SQLITE_CONSTRAINT that crashed the
    // whole hub. The card still surfaces; it just carries the id in its payload
    // (which the run-smithers watcher polls) instead of a dangling FK link.
    const approval = createApproval(approvalCreateInput(req.body || {}, req.token || {}, { getRun }));
    await notifyTelegram(approval);
    res.status(201).json({ approval: withApprovalLinks(approval), idempotent: false });
  } catch (error) {
    console.error("create approval failed:", error.message);
    res.status(400).json({ error: "could not create approval" });
  }
}));
function resolveApprovalHttp(req, res, decision) {
  const approval = getApproval(req.params.id);
  if (!approval) return res.status(404).json({ error: "approval not found" });
  if (approval.status !== "pending") return res.status(409).json({ error: "approval is not pending", approval: withApprovalLinks(approval) });
  const resolved = resolveApproval(req.params.id, decision, req.token.name, req.body.comment || defaultApprovalComment(decision));
  // Approval rejection / changes_requested transitions the linked run to
  // `cancelled` via resolveApproval's direct updateRun call. Fire response-
  // endpoint delivery here so an approval-driven terminal state behaves the
  // same as /api/runs/:id/{complete,fail,cancel} for slice 2 egress.
  if (resolved?.runId && decisionTriggersTerminalDelivery(decision)) {
    dispatchRunResponseEndpointDelivery(resolved.runId);
  }
  res.json({ approval: withApprovalLinks(resolved) });
}
app.post("/api/approvals/:id/approve", requireAuth, requireScopes("api", "mcp", "approvals"), (req, res) => resolveApprovalHttp(req, res, "approved"));
app.post("/api/approvals/:id/reject", requireAuth, requireScopes("api", "mcp", "approvals"), (req, res) => resolveApprovalHttp(req, res, "rejected"));
app.post("/api/approvals/:id/request-changes", requireAuth, requireScopes("api", "mcp", "approvals"), (req, res) =>
  resolveApprovalHttp(req, res, "changes_requested")
);

registerRunnerRoutes(app, { requireAuth, requireScopes });

// --- In-app support chat ----------------------------------------------------
// Backs the hovering "Runyard user support agent" panel mounted in /app. The
// model is briefed once on the operator's current view + hash and returns a
// reply plus an optional JSON action block the browser executes (navigate,
// click, fill, api). Auth is required so the proxied api actions inherit the
// operator's scopes — never broaden access here.
app.get("/api/chat/status", requireAuth, (_req, res) => {
  res.json(supportAgentInfo());
});

app.post("/api/chat", requireAuth, rateLimit({ bucket: "support-chat", max: 60, windowMs: 60_000 }), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return res.status(400).json({ error: "messages array required" });
  try {
    // Resolve the operator's route into real, redacted app data server-side so
    // the agent answers from the actual run/event/workflow state rather than
    // the thin route descriptor the browser sends. Read-only; never throws.
    const baseContext = body.context && typeof body.context === "object" ? body.context : {};
    const live = buildSupportLiveContext(baseContext);
    const result = await chatWithSupportAgent({
      messages,
      context: { ...baseContext, live: live.text || "" }
    });
    recordAudit(
      req.token?.name || req.token?.id || "unknown",
      "chat.message",
      `support-agent:${result.provider}/${result.model}`,
      { view: baseContext.view || "", turns: messages.length, contextKind: live.kind || "" }
    );
    res.json({
      reply: result.reply,
      provider: result.provider,
      model: result.model
    });
  } catch (error) {
    res.status(503).json({ error: error.message || "support agent unavailable" });
  }
}));

app.post("/api/telegram/webhook", asyncHandler(async (req, res) => {
  // Telegram authenticates webhooks via a secret token header configured on setWebhook.
  // Without a configured secret we refuse to act, so the endpoint can't be used to forge approvals.
  if (!env.telegramWebhookSecret) return res.status(503).json({ ok: false, error: "telegram webhook not configured" });
  const provided = req.headers["x-telegram-bot-api-secret-token"] || "";
  if (!timingSafeEqualStr(provided, env.telegramWebhookSecret)) return res.status(401).json({ ok: false });
  const callback = req.body.callback_query;
  if (callback?.data) {
    const parsed = parseTelegramApprovalCallback(callback.data);
    if (!parsed.ok) {
      await answerTelegramCallbackQuery(callback.id, parsed.error);
      return res.status(parsed.code).json({ ok: false, error: parsed.error });
    }
    // Only honor callbacks originating from the approval notification target.
    const target = telegramApprovalTarget();
    const chatId = String(callback.message?.chat?.id ?? "");
    if (target?.chatId && chatId && chatId !== String(target.chatId)) {
      await answerTelegramCallbackQuery(callback.id, "Approval button came from the wrong chat.");
      return res.status(403).json({ ok: false, error: "telegram callback chat mismatch" });
    }
    const approval = getApproval(parsed.approvalId);
    if (!approval) {
      await answerTelegramCallbackQuery(callback.id, "Approval was not found.");
      return res.status(404).json({ ok: false, error: "approval not found" });
    }
    if (approval.status !== "pending") {
      await answerTelegramCallbackQuery(callback.id, `Approval is already ${approval.status}.`);
      await clearTelegramApprovalButtons(callback);
      return res.status(409).json({ ok: false, error: "approval is not pending", approval: withApprovalLinks(approval) });
    }
    const who = `telegram:${callback.from?.username || callback.from?.id || "user"}`;
    const comment = parsed.decision === "changes_requested" ? "Changes requested from Telegram" : `${approvalDecisionLabel(parsed.decision)} from Telegram`;
    const resolved = resolveApproval(parsed.approvalId, parsed.decision, who, comment);
    // Same approval-driven terminal hook as the HTTP path: rejection /
    // changes_requested cancels the linked run; fire response-endpoint
    // delivery so the caller's webhook/telegram chat sees the result.
    if (resolved?.runId && (parsed.decision === "rejected" || parsed.decision === "changes_requested")) {
      dispatchRunResponseEndpointDelivery(resolved.runId);
    }
    await answerTelegramCallbackQuery(callback.id, `${approvalDecisionLabel(parsed.decision)}.`);
    await clearTelegramApprovalButtons(callback);
    return res.json({ ok: true, approval: withApprovalLinks(resolved) });
  }
  res.json({ ok: true, ignored: "no callback query data" });
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  // Respect known client errors (body too large, malformed JSON) but never leak internals.
  const status = error.status || error.statusCode;
  if (status === 413) return res.status(413).json({ error: "payload too large" });
  if (status === 400 && error.type) return res.status(400).json({ error: "invalid request body" });
  res.status(500).json({ error: "internal server error" });
});

if (process.argv[1]?.endsWith("server.js")) {
  // Reliability net: a single malformed request must never take down the live
  // control plane. Express 4 does not catch async-handler rejections, so a
  // throw inside an `async (req,res)=>{}` route (e.g. an unexpected SQLITE
  // constraint) becomes an unhandledRejection that, under Node's default, kills
  // the process. We log and keep serving instead — the SQLite DB is durable
  // (WAL) and each request is independent, so staying up in a slightly degraded
  // state beats dropping every SSE tail + in-flight response on a hub restart.
  // (Installed only when run as the server, never when imported by tests.)
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection (hub stays up):", reason instanceof Error ? reason.stack : reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("uncaughtException (hub stays up):", error?.stack || error);
  });
  app.listen(env.port, env.host, () => {
    console.log(`${env.instanceName} listening on http://${env.host}:${env.port}`);
  });
  // Periodically auto-fail runs whose runner died mid-execution.
  const reaper = setInterval(() => {
    try {
      reapStuckRunsWithRetrospectives(env.runDeadlineMs);
    } catch (error) {
      console.error("Run reaper failed:", error.message);
    }
    try {
      // Hub-as-supervisor backstop: resume runs a runner self-reported as
      // `failed` but that still carry a resumable checkpoint and budget. The
      // orphaned-runner case is handled inline by the reaper above; this catches
      // clean failures the in-band supervisor isn't covering. Phase 2 code
      // repair stays off by default (HUB_SUPERVISOR_REPAIR_ENABLED) — when
      // disabled, deterministic code-bug failures escalate to an operator card
      // instead of an auto-repair, which is the safe behavior while the on-box
      // Codex CLI auth is expired.
      const acted = reconcileFailedRecoverable({
        dispatchRepair: env.hubSupervisorRepairEnabled ? dispatchHubRepair : null
      });
      if (acted.length) console.log(`Hub supervisor reconciled ${acted.length} failed-recoverable run(s): ${acted.join(", ")}`);
    } catch (error) {
      console.error("Hub supervisor reconcile failed:", error.message);
    }
    try {
      // Self-correct any drift in the cached per-runner active_runs counter by
      // recomputing it from real run state. Runs BEFORE pruneDeadRunners (which
      // reads active_runs) so a stale "full" counter can't wedge the queue or
      // block pruning of a genuinely idle runner between restarts.
      const corrected = reconcileRunnerActiveRuns();
      if (corrected.length) {
        console.log(
          `Reconciled active_runs for ${corrected.length} runner(s): ` +
            corrected.map((c) => `${c.id} ${c.from}->${c.to}`).join(", ")
        );
      }
    } catch (error) {
      console.error("active_runs reconcile failed:", error.message);
    }
    try {
      // Prune long-dead runner rows (ghosts from pre-stable-identity restarts).
      // Never touches runners with in-flight work; see pruneDeadRunners.
      const pruned = pruneDeadRunners(env.runnerPruneMs);
      if (pruned.length) console.log(`Pruned ${pruned.length} dead runner(s): ${pruned.join(", ")}`);
    } catch (error) {
      console.error("Runner pruner failed:", error.message);
    }
  }, 60_000);
  reaper.unref?.();

  // Evaluate due cron/one-shot schedules and fire them. We tick every 30s so a
  // minute-granular schedule fires within ~30s of its boundary; firing is
  // idempotent (claimScheduleFire) and missed ticks collapse to a single run.
  const scheduler = setInterval(() => {
    try {
      fireDueSchedules();
    } catch (error) {
      console.error("Schedule ticker failed:", error.message);
    }
  }, 30_000);
  scheduler.unref?.();

  // Passive, outbound-only update check. Refreshes the cached latest-release
  // reading so the admin badge can show "update available". Never installs
  // anything; failures degrade to "unknown" inside check(). Toggle with
  // UPDATE_CHECK_ENABLED. The first check runs shortly after boot, not inline,
  // so a slow/blocked GitHub never delays startup.
  if (env.updateCheckEnabled) {
    const runUpdateCheck = () => {
      updateChecker.check().catch(() => {});
    };
    const kick = setTimeout(runUpdateCheck, 5_000);
    kick.unref?.();
    const updatePoll = setInterval(runUpdateCheck, Math.max(60_000, env.updateCheckIntervalMs));
    updatePoll.unref?.();
  }
}

export {
  app,
  fireDueSchedules,
  notifyTelegram,
  parseTelegramApprovalCallback,
  telegramApprovalTarget
};
