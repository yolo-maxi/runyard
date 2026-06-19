import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import express from "express";
import {
  addRunEvent,
  authenticateToken,
  approvalPolicyNotifiesTelegram,
  createAccessToken,
  createArtifact,
  createRun,
  dashboardStats,
  getArtifact,
  getApproval,
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
  reapStuckRunIds,
  recordAudit,
  registerRunner,
  resolveApproval,
  revokeAccessToken,
  runOwnerTokenId,
  runnerPoolStats,
  transitionRun,
  upsertAgent,
  upsertCapability,
  upsertKnowledge,
  upsertSkill,
  updateRun
} from "./db.js";
import { env } from "./env.js";
import { now, slugify } from "./ids.js";
import { buildRunRetrospectiveArtifact, RUN_RETROSPECTIVE_ARTIFACT_NAME } from "./runRetrospective.js";
import {
  analyzeRunObstructions,
  obstructionAnalyzerConfigured,
  redactAnalysisText,
  RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME
} from "./runObstructionAnalysis.js";
import { executionIntentFromInput, normalizeExecutionIntent } from "./runExecution.js";
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
const SESSION_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365;
const TELEGRAM_WEBAPP_SESSION_PREFIX = "telegram-webapp:";
const TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24;
const TELEGRAM_WEBAPP_AUTH_MAX_AGE_SECONDS = 10 * 60;
const TELEGRAM_WEBAPP_AUTH_FUTURE_SKEW_SECONDS = 60;
const pendingObstructionAnalyses = new Set();

function publicUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function normalizeChainSteps(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((step) => {
      if (typeof step === "string") return { capability: step, input: {} };
      if (!step || typeof step !== "object") return null;
      const capability = String(step.capability || step.capabilitySlug || step.slug || "").trim();
      if (!capability) return null;
      const input = step.input && typeof step.input === "object" && !Array.isArray(step.input) ? step.input : {};
      return {
        capability,
        input,
        title: step.title ? String(step.title) : "",
        passPreviousOutput: step.passPreviousOutput !== false
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function chainMetadata(input = {}) {
  const chain = normalizeChainSteps(input.__chain || input.chain);
  const index = Number.isFinite(Number(input.__chainIndex)) ? Number(input.__chainIndex) : 0;
  return { chain, index: Math.max(0, index) };
}

// --- Deep-link helpers -------------------------------------------------------
// Stable hash routes consumed by the web app (and by anyone who pastes the
// link into chat). These are added to API responses as a non-breaking
// `deepLink` field so clients don't have to know the URL scheme.
const deepLinks = {
  run: (id) => `/app#runs/${encodeURIComponent(id)}`,
  runLogs: (id) => `/app#runs/${encodeURIComponent(id)}/logs`,
  runArtifacts: (id) => `/app#runs/${encodeURIComponent(id)}/artifacts`,
  workflow: (slug) => `/app#workflows/${encodeURIComponent(slug)}`,
  workflowRuns: (slug) => `/app#workflows/${encodeURIComponent(slug)}/runs`,
  workflowEdit: (slug) => `/app#workflows/${encodeURIComponent(slug)}/edit`,
  workflowRun: (slug) => `/app#workflows/${encodeURIComponent(slug)}/run`,
  agent: (slug) => `/app#agents/agents/${encodeURIComponent(slug)}`,
  artifact: (artifact) => {
    const id = typeof artifact === "object" ? artifact.id : artifact;
    const runId = typeof artifact === "object" ? artifact.runId : "";
    return runId
      ? `/app#runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(id)}`
      : `/app#runs`;
  },
  approval: (id) => `/app#approvals/${encodeURIComponent(id)}`
};

// --- Run summary derivation --------------------------------------------------
// Runs don't carry an explicit title/description; we derive readable defaults
// from input, capability, and timing so cards and detail pages have substance
// even on workflows that don't set them. Backward-compatible: all originals
// stay; we add `title`, `description`, `project`, `branch`, `durationMs`.
const PROJECT_INPUT_KEYS = ["project", "projectName", "workspace", "repo", "repository", "githubRepo", "target", "subdomain", "preferredSubdomain"];
const REPO_INPUT_KEYS = ["repo", "repository", "githubRepo", "repositoryUrl", "repoUrl", "GITHUB_REPOSITORY", "REPOSITORY", "REPO"];
const PATH_INPUT_KEYS = ["path", "targetPath", "repoPath", "projectPath", "cwd", "workingDirectory", "directory", "PWD", "CWD"];
const BRANCH_INPUT_KEYS = ["branch", "targetBranch", "baseBranch", "ref", "gitBranch", "GITHUB_REF_NAME", "BRANCH", "TARGET_BRANCH"];
const TITLE_INPUT_KEYS = ["title", "name", "goal", "task", "prompt", "topic", "idea", "workPrompt", "question"];
const DESCRIPTION_INPUT_KEYS = ["description", "summary", "notes", "scope", "constraints", "reason", "rationale", "context"];
const CHANGE_INPUT_KEYS = ["workPrompt", "idea", "spec", "change", "changes", "task", "goal", "prompt", "description", "summary", "context", "notes"];
const ACTION_INPUT_KEYS = ["proposedAction", "action", "operation", "command"];
const ORIGIN_INPUT_KEYS = ["requestedBy", "requester", "originator", "user", "username", "owner", "actor", "source", "from"];
const CONTEXT_OBJECT_KEYS = ["context", "metadata", "env", "environment", "project", "git"];

function firstString(input, keys) {
  if (!input || typeof input !== "object") return "";
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstContextString(input, keys) {
  const direct = firstString(input, keys);
  if (direct) return direct;
  if (!input || typeof input !== "object") return "";
  for (const parentKey of CONTEXT_OBJECT_KEYS) {
    const parent = input[parentKey];
    if (parent && typeof parent === "object" && !Array.isArray(parent)) {
      const nested = firstString(parent, keys);
      if (nested) return nested;
    }
  }
  return "";
}

function uniqueNonempty(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function truncate(text, max) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

function deriveRunTitle(run) {
  const fromInput = firstString(run.input, TITLE_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 90);
  return run.capabilityName || run.capabilitySlug || "Run";
}

function deriveRunDescription(run) {
  const fromInput = firstString(run.input, DESCRIPTION_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 240);
  const titleField = firstString(run.input, TITLE_INPUT_KEYS);
  if (titleField && titleField.length > 90) return truncate(titleField, 240);
  const parts = [];
  if (run.capabilityName) parts.push(run.capabilityName);
  if (run.currentStep) parts.push(run.currentStep);
  return truncate(parts.join(" — "), 240);
}

function normalizeOrigin(value) {
  if (!value) return null;
  if (typeof value === "string") return { label: value };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const cleaned = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item != null));
  if (!Object.keys(cleaned).length) return null;
  const label = cleaned.label || cleaned.name || cleaned.source || cleaned.from || cleaned.chat || cleaned.thread || "";
  return { ...cleaned, ...(label ? { label } : {}) };
}

function runOrigin(run) {
  const input = run?.input || {};
  const candidates = [
    normalizeOrigin(input.__origin),
    normalizeOrigin(input.origin),
    normalizeOrigin(input.source),
    normalizeOrigin(input.context?.origin),
    normalizeOrigin(input.metadata?.origin)
  ].filter(Boolean);
  const origin = candidates[0] || null;
  if (!origin) {
    const text = firstContextString(input, ORIGIN_INPUT_KEYS);
    return text ? { label: text } : null;
  }
  if (!origin.label) {
    const bits = uniqueNonempty([origin.type, origin.name, origin.chat, origin.thread, origin.messageId]);
    origin.label = bits.join(": ");
  }
  return origin.label ? origin : null;
}

function runDurationMs(run) {
  if (!run?.createdAt) return null;
  const start = Date.parse(run.startedAt || run.createdAt);
  const end = Date.parse(run.completedAt || new Date().toISOString());
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

// --- Failure / cancellation diagnostics -------------------------------------
// When a run lands in failed / error / cancelled / waiting_approval we expose a
// structured diagnostics object so the web app can show "why" up-front instead
// of forcing operators to scrape the raw log timeline. The same object backs
// the short reason hint on run cards.
const DIAGNOSTIC_STATUSES = new Set(["failed", "error", "cancelled", "rejected", "waiting_approval"]);

const FOCUS_EVENT_PATTERNS = [
  /^run\.(?:failed|cancelled|errored|started|succeeded|created)$/i,
  /^(?:node|task|step|workflow)\.(?:started|finished|completed|failed|errored|cancelled)$/i,
  /^approval\.(?:requested|resolved|approved|rejected|changes_requested|auto_queued)$/i,
  /^Node(?:Started|Finished|Failed|Cancelled)$/,
  /^Run(?:Started|Cancelled|Failed|Succeeded)$/,
  /^Approval(?:Requested|Resolved|Approved|Rejected|ChangesRequested)$/
];

function isFocusEvent(event) {
  const type = String(event?.type || "");
  return FOCUS_EVENT_PATTERNS.some((re) => re.test(type));
}

const LOG_EVENT_TYPES = new Set(["log", "stdout", "stderr", "workflow.log", "runner.log", "workflow.step"]);

function isLogEvent(event) {
  const type = String(event?.type || "");
  if (LOG_EVENT_TYPES.has(type)) return true;
  return /\.(?:log|stderr|stdout)$/i.test(type);
}

// Best-effort redaction so any log/event text we surface in the UI doesn't
// leak the obvious shapes of bearer tokens, API keys, JWTs, or session cookies.
const LOG_REDACTION_RULES = [
  { re: /(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(x-api-key\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(api[_-]?key\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(password\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(secret\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(token\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /\bshub_[A-Za-z0-9]+\b/g, replace: "shub_[redacted]" },
  { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replace: "sk-[redacted]" },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, replace: "ghp_[redacted]" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+\b/g, replace: "[redacted-jwt]" }
];

function redactSnippet(value, max = 600) {
  let text = String(value ?? "");
  for (const { re, replace } of LOG_REDACTION_RULES) text = text.replace(re, replace);
  return truncate(text, max);
}

function reverseFind(list, predicate) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (predicate(list[i])) return list[i];
  return null;
}

// --- Run log usability ------------------------------------------------------
// The raw run log is a flat firehose of events (heartbeats, traces, step
// markers, agent chatter). The Hub console needs a scannable default view that
// surfaces the key transitions and lets operators filter without scraping
// every line. We classify each event into a small set of categories and a
// severity, count them, group by node/step, and return a default-collapsed
// shape the client can render directly. Raw events stay available at
// /api/runs/:id/events and /logs.
const NOISY_EVENT_TYPES = new Set([
  "heartbeat",
  "runner.heartbeat",
  "workflow.heartbeat",
  "trace",
  "trace.span",
  "trace.event",
  "tracer",
  "claude.tool_use",
  "claude.tool_result",
  "claude.message_delta",
  "claude.content_block_delta",
  "claude.thinking",
  "agent.token",
  "agent.delta"
]);

const APPROVAL_EVENT_RE = /^approval\./i;
const NODE_EVENT_RE = /^(?:node|task|step)\.(?:started|finished|completed|failed|errored|cancelled|skipped)$/i;
const RUN_EVENT_RE = /^run\.(?:created|started|succeeded|failed|cancelled|errored|chain\..*|rerun_.*)$/i;
const STEP_MARKER_RE = /^workflow\.step$/i;
const AGENT_SUMMARY_RE = /^(?:agent|claude|codex)\.(?:summary|result|completed|final)$/i;
const GATE_RE = /(test|build|deploy|commit|push|gate|verify)/i;
const ERROR_HINT_RE = /(?:^|\s|:)(error|failed|panic|fatal|exception|timeout)\b/i;
const WARN_HINT_RE = /(?:^|\s|:)(warn(?:ing)?|deprecat|retrying|skipped)\b/i;

function eventCategory(event) {
  const type = String(event?.type || "");
  if (NOISY_EVENT_TYPES.has(type) || /\.(?:heartbeat|tick|ping)$/i.test(type)) return "noise";
  if (/\.(?:trace|span|delta|chunk|tool_use|tool_result|thinking)$/i.test(type)) return "trace";
  if (APPROVAL_EVENT_RE.test(type)) return "approval";
  if (RUN_EVENT_RE.test(type)) return "run";
  if (NODE_EVENT_RE.test(type)) return "node";
  if (STEP_MARKER_RE.test(type)) return "step";
  if (AGENT_SUMMARY_RE.test(type)) return "agent";
  if (isLogEvent(event)) return "log";
  return "other";
}

function eventSeverity(event) {
  const type = String(event?.type || "");
  if (/(?:^|\.)(?:failed|errored|fatal|panic)$/i.test(type)) return "error";
  if (type === "stderr") return "error";
  if (/(?:^|\.)(?:cancelled|skipped|warn|warning|deprecated)$/i.test(type)) return "warn";
  const text = String(event?.message || "");
  if (ERROR_HINT_RE.test(text)) return "error";
  if (WARN_HINT_RE.test(text)) return "warn";
  return "info";
}

function eventNode(event) {
  const data = event?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const field = data.node || data.nodeId || data.taskId || data.task || data.step;
    if (field) return String(field).slice(0, 80);
  }
  const type = String(event?.type || "");
  const dotted = type.match(/^(?:node|task|step)\.[a-z]+$/i);
  if (dotted && data?.id) return String(data.id).slice(0, 80);
  return "";
}

const HIGHLIGHT_CATEGORIES = new Set(["run", "node", "approval", "agent", "step"]);
const DEFAULT_COLLAPSED_CATEGORIES = ["noise", "trace"];

function eventTypeLabel(type) {
  return String(type || "").trim() || "log";
}

// Sort categories so the most useful chips appear first in the filter bar.
const CATEGORY_ORDER = ["run", "node", "approval", "agent", "step", "log", "other", "trace", "noise"];
function sortCategoryEntries(entries) {
  return entries.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.key);
    const bi = CATEGORY_ORDER.indexOf(b.key);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function summarizeRunEvents(events = [], { highlightCap = 40, perNodeCap = 6 } = {}) {
  if (!events.length) {
    return {
      totals: { events: 0, highlights: 0, errors: 0, warnings: 0 },
      categories: [],
      severities: [],
      types: [],
      nodes: [],
      defaultCollapsed: DEFAULT_COLLAPSED_CATEGORIES,
      highlights: []
    };
  }
  const sorted = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const categoryCounts = new Map();
  const severityCounts = new Map();
  const typeCounts = new Map();
  const nodeStats = new Map();
  const highlights = [];
  const nodeWindow = new Map();
  let errors = 0;
  let warnings = 0;
  for (const event of sorted) {
    const category = eventCategory(event);
    const severity = eventSeverity(event);
    const type = eventTypeLabel(event.type);
    const node = eventNode(event);
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    severityCounts.set(severity, (severityCounts.get(severity) || 0) + 1);
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    if (severity === "error") errors += 1;
    if (severity === "warn") warnings += 1;
    if (node) {
      const stat = nodeStats.get(node) || { node, total: 0, errors: 0, warnings: 0, lastSeverity: "info", lastCategory: "other", lastAt: event.createdAt, sampleType: type };
      stat.total += 1;
      if (severity === "error") stat.errors += 1;
      if (severity === "warn") stat.warnings += 1;
      stat.lastSeverity = severity;
      stat.lastCategory = category;
      stat.lastAt = event.createdAt;
      stat.sampleType = type;
      nodeStats.set(node, stat);
    }
    const interesting = HIGHLIGHT_CATEGORIES.has(category) || severity === "error" || severity === "warn" || GATE_RE.test(type);
    if (!interesting) continue;
    // Per-node throttle so a single chatty node can't crowd the highlight list.
    if (node) {
      const seen = nodeWindow.get(node) || 0;
      if (seen >= perNodeCap) continue;
      nodeWindow.set(node, seen + 1);
    }
    highlights.push({
      id: event.id,
      type,
      category,
      severity,
      node,
      message: redactSnippet(event.message, 320),
      createdAt: event.createdAt
    });
  }
  // Keep the highlight feed bounded so the JSON payload stays small even on
  // very long runs; the raw log endpoint covers the unfiltered case.
  const trimmedHighlights = highlights.slice(-highlightCap);
  const categories = sortCategoryEntries(
    [...categoryCounts.entries()].map(([key, count]) => ({
      key,
      count,
      collapsedByDefault: DEFAULT_COLLAPSED_CATEGORIES.includes(key)
    }))
  );
  const severities = ["error", "warn", "info"]
    .map((key) => ({ key, count: severityCounts.get(key) || 0 }))
    .filter((entry) => entry.count > 0);
  const types = [...typeCounts.entries()]
    .map(([key, count]) => ({ key, count, category: eventCategory({ type: key }) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
  const nodes = [...nodeStats.values()]
    .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")))
    .slice(0, 30);
  return {
    totals: {
      events: sorted.length,
      highlights: trimmedHighlights.length,
      errors,
      warnings
    },
    categories,
    severities,
    types,
    nodes,
    defaultCollapsed: DEFAULT_COLLAPSED_CATEGORIES,
    highlights: trimmedHighlights
  };
}

function findFailureEvent(events) {
  return reverseFind(events, (event) => {
    const type = String(event?.type || "");
    if (/^run\.(?:failed|cancelled|errored)$/i.test(type)) return true;
    if (/^(?:node|task|step|workflow)\.(?:failed|errored|cancelled)$/i.test(type)) return true;
    if (/^Node(?:Failed|Cancelled)$/.test(type)) return true;
    if (/^Run(?:Failed|Cancelled)$/.test(type)) return true;
    return false;
  });
}

function failureStep(run, events, failureEvent) {
  const data = failureEvent?.data;
  if (data && typeof data === "object") {
    const field = data.step || data.node || data.taskId || data.task || data.nodeId;
    if (field) return String(field);
  }
  if (run?.currentStep) return run.currentStep;
  const lastStep = reverseFind(events, (event) => /^workflow\.step$/i.test(event.type));
  return lastStep?.message || "";
}

function focusedTimeline(events, failureEvent) {
  if (!events?.length) return [];
  const failureIndex = failureEvent ? events.findIndex((e) => e.id === failureEvent.id) : events.length - 1;
  const anchor = failureIndex < 0 ? events.length - 1 : failureIndex;
  const window = events.slice(Math.max(0, anchor - 12), Math.min(events.length, anchor + 4));
  return window.filter(isFocusEvent).map((event) => ({
    id: event.id,
    type: event.type,
    message: redactSnippet(event.message, 320),
    createdAt: event.createdAt,
    data: sanitizeForDisplay(event.data || {})
  }));
}

function logExcerpts(events, failureEvent) {
  if (!events?.length) return [];
  const failureIndex = failureEvent ? events.findIndex((e) => e.id === failureEvent.id) : events.length - 1;
  const end = failureIndex < 0 ? events.length : failureIndex + 1;
  const window = events.slice(Math.max(0, end - 30), end);
  const logs = window.filter(isLogEvent);
  return logs.slice(-12).map((event) => ({
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    message: redactSnippet(event.message, 600)
  }));
}

function diagnosticArtifactScore(artifact) {
  const name = String(artifact?.name || "").toLowerCase();
  const mime = String(artifact?.mimeType || "").toLowerCase();
  let score = 0;
  if (/error|failure|stderr|stdout|trace|diagnostic|panic|crash|core\b/.test(name)) score += 3;
  if (/\.(?:log|txt)$/.test(name)) score += 1;
  if (mime === "text/x-log") score += 2;
  if (mime.startsWith("text/")) score += 1;
  return score;
}

function diagnosticArtifacts(artifacts) {
  return (artifacts || [])
    .map((artifact) => ({ artifact, score: diagnosticArtifactScore(artifact) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || String(b.artifact.createdAt || "").localeCompare(String(a.artifact.createdAt || ""))
    )
    .slice(0, 6)
    .map((entry) => withArtifactLinks(entry.artifact));
}

function relevantApproval(runId) {
  if (!runId) return null;
  const approvals = listApprovals().filter((a) => a.runId === runId);
  if (!approvals.length) return null;
  return (
    approvals.find((a) => a.status === "pending")
    || approvals.find((a) => a.decision === "changes_requested")
    || approvals.find((a) => a.decision === "rejected")
    || approvals[0]
  );
}

function approvalSummaryForDiagnostics(approval) {
  if (!approval) return null;
  return {
    id: approval.id,
    status: approval.status,
    decision: approval.decision || "",
    title: approval.title || "",
    comment: approval.comment ? truncate(approval.comment, 600) : "",
    requestedBy: approval.requestedBy || "",
    resolvedBy: approval.resolvedBy || "",
    resolvedAt: approval.resolvedAt || "",
    deepLink: deepLinks.approval(approval.id)
  };
}

function runDiagnostics(run, events = [], artifacts = []) {
  if (!run || !DIAGNOSTIC_STATUSES.has(run.status)) return null;
  const sortedEvents = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const failureEvent = findFailureEvent(sortedEvents);
  const approval = relevantApproval(run.id);
  const cancelEvent = reverseFind(sortedEvents, (event) => /^run\.cancelled$/i.test(event.type));
  // Only treat the approval comment as the cancellation reason when the
  // approval actually drove the cancellation. Otherwise prefer the run-level
  // event/error so we don't surface a stale "Approved from Web/API" comment
  // on an unrelated cancel.
  const approvalCausedCancel = Boolean(
    approval
    && (approval.decision === "changes_requested"
      || approval.decision === "rejected"
      || approval.status === "rejected")
  );
  let headline;
  if (run.status === "failed" || run.status === "error") {
    headline = redactSnippet(run.error || failureEvent?.message || run.currentStep || "Run failed", 200);
  } else if (run.status === "cancelled" || run.status === "rejected") {
    headline = redactSnippet(
      (approvalCausedCancel && approval?.comment)
      || cancelEvent?.message
      || failureEvent?.message
      || (approval?.comment)
      || run.currentStep
      || "Run cancelled",
      200
    );
  } else if (run.status === "waiting_approval") {
    headline = truncate(approval?.title || run.currentStep || "Waiting for approval", 200);
  } else {
    headline = truncate(run.currentStep || run.status, 200);
  }
  const step = failureStep(run, sortedEvents, failureEvent);
  return {
    status: run.status,
    headline,
    reason: redactSnippet(run.error || failureEvent?.message || headline, 600),
    failedStep: step || "",
    failureType: failureEvent?.type || (cancelEvent ? cancelEvent.type : ""),
    failedAt: failureEvent?.createdAt || cancelEvent?.createdAt || run.completedAt || null,
    cancelledBy:
      run.status === "cancelled" || run.status === "rejected"
        ? approval?.resolvedBy
          || (cancelEvent?.data && (cancelEvent.data.cancelledBy || cancelEvent.data.actor)) || ""
        : "",
    approval: approvalSummaryForDiagnostics(approval),
    timeline: focusedTimeline(sortedEvents, failureEvent || cancelEvent || null),
    logExcerpts: logExcerpts(sortedEvents, failureEvent || cancelEvent || null),
    artifacts: diagnosticArtifacts(artifacts),
    createdAt: run.createdAt,
    completedAt: run.completedAt
  };
}

// Cheap short hint for run cards — does not run extra DB queries; built only
// from the fields already in the run row. The detail page enriches this with
// the structured diagnostics object instead.
function quickReasonHint(run) {
  if (!run || !DIAGNOSTIC_STATUSES.has(run.status)) return "";
  if (run.status === "failed" || run.status === "error") {
    return truncate(run.error || run.currentStep || "Run failed", 140);
  }
  if (run.status === "cancelled" || run.status === "rejected") {
    return truncate(run.error || run.currentStep || "Run cancelled", 140);
  }
  if (run.status === "waiting_approval") {
    return truncate(run.currentStep || "Waiting for approval", 140);
  }
  return "";
}

// Caller-side helper so we can pre-compute a queue index once per response
// and avoid an N+1 DB scan when rendering a long list of runs. `queueIndex`
// is a Map of runId -> 1-based position in the FIFO of currently-queued runs.
function buildQueueIndex(runs) {
  const queued = (runs || [])
    .filter((r) => r && r.status === "queued")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const map = new Map();
  queued.forEach((run, i) => map.set(run.id, i + 1));
  return { map, total: queued.length };
}

function withRunLinks(run, queueIndex = null) {
  if (!run || typeof run !== "object") return run;
  const origin = runOrigin(run);
  const execution = executionIntentFromInput(run.input || {});
  const reasonHint = quickReasonHint(run);
  const queue = run.status === "queued" && queueIndex
    ? { position: queueIndex.map.get(run.id) || null, total: queueIndex.total }
    : null;
  return {
    ...run,
    title: deriveRunTitle(run),
    description: deriveRunDescription(run),
    project: firstContextString(run.input, PROJECT_INPUT_KEYS),
    branch: firstContextString(run.input, BRANCH_INPUT_KEYS),
    origin,
    originLabel: origin?.label || "",
    execution,
    durationMs: runDurationMs(run),
    reasonHint,
    ...(queue ? { queue } : {}),
    deepLink: deepLinks.run(run.id),
    deepLinkLogs: deepLinks.runLogs(run.id),
    deepLinkArtifacts: deepLinks.runArtifacts(run.id),
    ...(run.capabilitySlug ? { deepLinkWorkflow: deepLinks.workflow(run.capabilitySlug) } : {})
  };
}

// When we have a single run (not a list), compute its queue position on the
// fly from the live queued backlog.
function decorateSingleRun(run) {
  if (!run) return run;
  if (run.status !== "queued") return withRunLinks(run);
  const queueIndex = buildQueueIndex(listRuns({ status: "queued", limit: 500 }));
  return withRunLinks(run, queueIndex);
}

function withCapabilityLinks(cap) {
  if (!cap || typeof cap !== "object") return cap;
  return {
    ...cap,
    deepLink: deepLinks.workflow(cap.slug),
    deepLinkRuns: deepLinks.workflowRuns(cap.slug),
    deepLinkEdit: deepLinks.workflowEdit(cap.slug),
    deepLinkRun: deepLinks.workflowRun(cap.slug)
  };
}

function withAgentLinks(agent) {
  if (!agent || typeof agent !== "object") return agent;
  return { ...agent, deepLink: deepLinks.agent(agent.slug) };
}

function withArtifactLinks(artifact) {
  if (!artifact || typeof artifact !== "object") return artifact;
  return { ...artifact, deepLink: deepLinks.artifact(artifact), deepLinkRun: deepLinks.run(artifact.runId) };
}

function hubMenuPayload(req) {
  const capabilities = listCapabilities().map((capability) => {
    const linked = withCapabilityLinks(capability);
    return {
      slug: linked.slug,
      name: linked.name,
      description: linked.description,
      category: linked.category,
      requiredRunnerTags: linked.requiredRunnerTags,
      deepLink: linked.deepLink,
      runWithCli: `smithers-hub run ${linked.slug} --where local --input '{}'`,
      runWithMcp: { tool: "run_capability", arguments: { id: linked.slug, input: {}, executionMode: "local" } }
    };
  });
  return {
    product: "Runyard",
    codebase: "smithers-hub",
    hub: {
      sourceOfTruth: true,
      status: `${publicUrl(req)}/api/runs/{runId}`,
      logs: `${publicUrl(req)}/api/runs/{runId}/logs`,
      artifacts: `${publicUrl(req)}/api/runs/{runId}/artifacts`,
      note: "Runs, outputs, logs, and artifacts are recorded in the Hub even when execution happens on a local runner."
    },
    discovery: [
      { surface: "MCP", action: "Call get_menu, then list_capabilities or describe_capability." },
      { surface: "CLI", action: "Run smithers-hub menu, then smithers-hub capabilities or smithers-hub capability <slug>." },
      { surface: "Web", action: "Open /app and use Workflows, Runs, Approvals, and Connect." }
    ],
    executionModes: [
      {
        id: "local",
        label: "Run locally",
        runnerLocation: "local",
        cli: "smithers-hub run <capability> --where local --input '<json>'",
        mcp: { tool: "run_capability", arguments: { id: "<capability>", input: {}, executionMode: "local" } },
        runner: "smithers-hub runner start --location local",
        result: "The local runner executes the workflow; outputs and artifacts are fetched from the Hub."
      },
      {
        id: "remote",
        label: "Run remotely",
        runnerLocation: "vps",
        cli: "smithers-hub run <capability> --where remote --input '<json>'",
        mcp: { tool: "run_capability", arguments: { id: "<capability>", input: {}, executionMode: "remote" } },
        runner: "Use the shared VPS/remote runner pool tagged vps or remote.",
        result: "A remote runner executes the workflow; outputs and artifacts are fetched from the Hub."
      }
    ],
    tools: [
      "get_menu",
      "list_capabilities",
      "describe_capability",
      "run_capability",
      "get_run_status",
      "get_run_logs",
      "get_run_artifacts",
      "list_runners",
      "list_pending_approvals"
    ],
    capabilities,
    pool: runnerPoolStats()
  };
}

function absoluteDeepLink(link) {
  try {
    return new URL(link, env.baseUrl).toString();
  } catch {
    return `${String(env.baseUrl || "").replace(/\/$/, "")}${link}`;
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

const SECRET_FIELD_RE = /(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i;

function sanitizeForDisplay(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncate(value, 500);
  if (depth >= 3) return "[nested value]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 12).map((item) => sanitizeForDisplay(item, depth + 1));
    return value.length > items.length ? [...items, `... ${value.length - items.length} more`] : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 24);
    const output = {};
    for (const [key, item] of entries) {
      output[key] = SECRET_FIELD_RE.test(key) ? "[redacted]" : sanitizeForDisplay(item, depth + 1);
    }
    if (Object.keys(value).length > entries.length) output._truncated = `${Object.keys(value).length - entries.length} more fields`;
    return output;
  }
  return String(value);
}

function approvalInput(approval, run = null) {
  const payloadInput = approval?.payload?.input;
  if (payloadInput && typeof payloadInput === "object" && !Array.isArray(payloadInput)) return payloadInput;
  return run?.input && typeof run.input === "object" ? run.input : {};
}

function approvalPayloadSummary(approval) {
  const payload = approval?.payload || {};
  const summary = {};
  if (payload.capability) summary.capability = payload.capability;
  if (payload.input) summary.input = sanitizeForDisplay(payload.input);
  for (const [key, value] of Object.entries(payload)) {
    if (key === "capability" || key === "input") continue;
    summary[key] = SECRET_FIELD_RE.test(key) ? "[redacted]" : sanitizeForDisplay(value);
  }
  return summary;
}

function approvalRequestedBy(approval, input) {
  const payloadOrigin = approval?.payload?.origin;
  if (payloadOrigin && typeof payloadOrigin === "object") {
    const name = firstString(payloadOrigin, ["name", "tokenName", "actor", "source"]);
    const via = firstString(payloadOrigin, ["via", "type", "channel"]);
    if (name && via) return `${via}: ${name}`;
    if (name) return name;
  }
  const inputOrigin = firstContextString(input, ORIGIN_INPUT_KEYS);
  return inputOrigin || approval?.requestedBy || "workflow";
}

function approvalProjectContext(input) {
  const project = firstContextString(input, PROJECT_INPUT_KEYS);
  const repo = firstContextString(input, REPO_INPUT_KEYS);
  const pathValue = firstContextString(input, PATH_INPUT_KEYS);
  const branch = firstContextString(input, BRANCH_INPUT_KEYS);
  const targetBranch = firstContextString(input, ["targetBranch", "TARGET_BRANCH"]) || branch;
  const display = uniqueNonempty([project, repo, pathValue]).join(" / ");
  return {
    project,
    repo,
    path: pathValue,
    branch,
    targetBranch,
    display
  };
}

function approvalProposedChange(input, run, approval) {
  const fromInput = firstContextString(input, CHANGE_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 700);
  const runDescription = run ? deriveRunDescription(run) : "";
  if (runDescription) return truncate(runDescription, 700);
  return truncate(approval?.description || "", 700);
}

function approvalProposedAction(input, run, workflowName, deploy, targetBranch) {
  const fromInput = firstContextString(input, ACTION_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 320);
  if (!run) return "Mark this approval approved.";
  const parts = [`Queue ${workflowName || "this workflow"} for runner execution`];
  if (deploy != null) parts.push(deploy ? "with deploy enabled" : "with deploy disabled");
  if (targetBranch) parts.push(`targeting ${targetBranch}`);
  return `${parts.join(", ")}.`;
}

function approvalContext(approval) {
  const run = approval?.runId ? getRun(approval.runId) : null;
  const input = approvalInput(approval, run);
  const capabilitySlug = approval?.payload?.capability || run?.capabilitySlug || "";
  const capability = capabilitySlug ? getCapability(capabilitySlug) : null;
  const workflowName = run?.capabilityName || capability?.name || capabilitySlug || "";
  const deployPresent = hasOwn(input, "deploy");
  const deploy = deployPresent ? Boolean(input.deploy) : null;
  const project = approvalProjectContext(input);
  const proposedChange = approvalProposedChange(input, run, approval);
  return {
    approval: {
      id: approval?.id || "",
      status: approval?.status || ""
    },
    requestedBy: approvalRequestedBy(approval, input),
    workflow: workflowName
      ? {
          slug: capabilitySlug,
          name: workflowName,
          version: run?.workflowVersion || capability?.version || null,
          deepLink: capabilitySlug ? deepLinks.workflow(capabilitySlug) : ""
        }
      : null,
    project,
    deploy,
    branch: project.branch || "",
    targetBranch: project.targetBranch || "",
    run: run
      ? {
          id: run.id,
          status: run.status,
          title: deriveRunTitle(run),
          description: deriveRunDescription(run),
          currentStep: run.currentStep,
          deepLink: deepLinks.run(run.id)
        }
      : null,
    inputTitle: firstContextString(input, TITLE_INPUT_KEYS),
    proposedAction: approvalProposedAction(input, run, workflowName, deploy, project.targetBranch),
    proposedChange,
    whatHappensIfApproved: run
      ? "The run will move from waiting_approval to queued, then a matching runner can execute it."
      : "This approval will be marked approved.",
    whatHappensIfChangesRequested: run
      ? "The approval will record changes_requested, the run will be cancelled, and the comment should describe the requested changes."
      : "This approval will record changes_requested.",
    whatHappensIfRejected: run ? "The run will be cancelled and will not execute." : "This approval will be marked rejected."
  };
}

function withApprovalLinks(approval) {
  if (!approval || typeof approval !== "object") return approval;
  return {
    ...approval,
    deepLink: deepLinks.approval(approval.id),
    ...(approval.runId ? { deepLinkRun: deepLinks.run(approval.runId) } : {}),
    context: approvalContext(approval),
    payloadSummary: approvalPayloadSummary(approval)
  };
}

function csvValues(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function firstCsvValue(value) {
  return csvValues(value)[0] || "";
}

function telegramApprovalUserAllowlist() {
  return new Set(csvValues(env.telegramApprovalUserIds || env.telegramApprovalChatId).map(String));
}

function telegramUserLabel(user) {
  const handle = user?.username || [user?.first_name, user?.last_name].filter(Boolean).join(" ");
  return `telegram:${handle || user?.id || "user"}`;
}

function parseTelegramUser(raw) {
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    if (user && user.id != null) return user;
  } catch {
    return null;
  }
  return null;
}

function verifyTelegramWebAppInitData(initData) {
  if (!env.telegramBotToken) return { ok: false, code: 503, error: "telegram webapp auth not configured" };
  if (typeof initData !== "string" || !initData.trim() || initData.length > 8192) {
    return { ok: false, code: 400, error: "missing telegram init data" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!/^[a-f0-9]{64}$/i.test(hash)) return { ok: false, code: 401, error: "invalid telegram signature" };

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") pairs.push([key, value]);
  }
  if (!pairs.length) return { ok: false, code: 401, error: "invalid telegram signature" };

  pairs.sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = pairs.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(env.telegramBotToken).digest();
  const expectedHash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!timingSafeEqualStr(hash.toLowerCase(), expectedHash)) {
    return { ok: false, code: 401, error: "invalid telegram signature" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || authDate > nowSeconds + TELEGRAM_WEBAPP_AUTH_FUTURE_SKEW_SECONDS) {
    return { ok: false, code: 401, error: "invalid telegram auth date" };
  }
  if (nowSeconds - authDate > TELEGRAM_WEBAPP_AUTH_MAX_AGE_SECONDS) {
    return { ok: false, code: 401, error: "telegram auth expired" };
  }

  const user = parseTelegramUser(params.get("user"));
  if (!user) return { ok: false, code: 401, error: "telegram user missing" };
  const allowlist = telegramApprovalUserAllowlist();
  if (!allowlist.size) return { ok: false, code: 503, error: "telegram approval operator not configured" };
  if (!allowlist.has(String(user.id))) return { ok: false, code: 403, error: "telegram user is not authorized" };

  return { ok: true, authDate, user };
}

function createTelegramWebAppSession(user) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    type: "telegram-webapp",
    uid: String(user.id),
    name: telegramUserLabel(user),
    scopes: ["approvals"],
    iat: issuedAt,
    exp: issuedAt + Math.floor(TELEGRAM_WEBAPP_SESSION_MAX_AGE_MS / 1000)
  };
  return `${TELEGRAM_WEBAPP_SESSION_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function authenticateTelegramWebAppSession(value) {
  if (!String(value || "").startsWith(TELEGRAM_WEBAPP_SESSION_PREFIX)) return null;
  try {
    const encoded = String(value).slice(TELEGRAM_WEBAPP_SESSION_PREFIX.length);
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload?.type !== "telegram-webapp" || !payload.uid || !Array.isArray(payload.scopes)) return null;
    if (Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
    if (!telegramApprovalUserAllowlist().has(String(payload.uid))) return null;
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

function authenticateSessionValue(value) {
  return authenticateTelegramWebAppSession(value) || authenticateToken(value);
}

function telegramSessionCanAccess(req) {
  if (req.method === "GET" && req.path === "/api/me") return true;
  if (req.method === "GET" && /^\/api\/approvals(?:\/[^/]+)?\/?$/.test(req.path)) return true;
  if (req.method === "POST" && /^\/api\/approvals\/[^/]+\/(?:approve|reject|request-changes)\/?$/.test(req.path)) return true;
  if (req.method === "GET" && /^\/api\/runs(?:\/[^/]+(?:\/(?:events|logs|artifacts))?)?\/?$/.test(req.path)) return true;
  if (req.method === "GET" && /^\/api\/artifacts\/[^/]+\/download\/?$/.test(req.path)) return true;
  return false;
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

function requestOrigin(req, input = {}) {
  const token = req.token || {};
  const scopes = token.scopes || [];
  const via = scopes.includes("mcp") && !scopes.includes("api") ? "mcp" : scopes.includes("runner") && !scopes.includes("api") ? "runner" : "token";
  const explicit = normalizeOrigin(req.body?.origin) || normalizeOrigin(input?.origin) || normalizeOrigin(input?.source) || normalizeOrigin(input?.context?.origin);
  const headerOrigin = normalizeOrigin({
    label: req.headers["x-smithers-origin"] || "",
    url: req.headers["x-smithers-origin-url"] || "",
    chat: req.headers["x-smithers-origin-chat"] || "",
    thread: req.headers["x-smithers-origin-thread"] || "",
    messageId: req.headers["x-smithers-origin-message-id"] || ""
  });
  return {
    requestedBy: `${via}: ${token.name || token.id || "unknown"}`,
    origin: {
      label: `${via}: ${token.name || token.id || "unknown"}`,
      type: via,
      name: token.name || "",
      scopes,
      ...(headerOrigin || {}),
      ...(explicit || {})
    }
  };
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

function telegramApprovalTarget() {
  const approvalChatId = firstCsvValue(env.telegramApprovalChatId);
  if (approvalChatId) return { chatId: approvalChatId, private: true };
  if (env.telegramChatId) {
    const threadId = Number(env.telegramThreadId);
    return {
      chatId: env.telegramChatId,
      private: false,
      ...(env.telegramThreadId && Number.isFinite(threadId) ? { threadId } : {})
    };
  }
  return null;
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function telegramCode(value) {
  return `<code>${htmlEscape(value)}</code>`;
}

function telegramLabeledLine(label, value) {
  if (value == null || value === "") return "";
  return `<b>${htmlEscape(label)}:</b> ${htmlEscape(value)}`;
}

function telegramApprovalText(approval) {
  const context = approvalContext(approval);
  const workflow = context.workflow?.name
    ? `${context.workflow.name}${context.workflow.slug ? ` (${context.workflow.slug})` : ""}`
    : "Unknown workflow";
  const proposedChange = truncate(context.proposedChange || approval?.title || approval?.description || "Approval request", 900);
  const proposedAction = truncate(context.proposedAction || "Resolve this approval.", 320);
  const branchLine = context.targetBranch ? telegramLabeledLine("Target branch", context.targetBranch) : telegramLabeledLine("Branch", context.branch);
  const runLine = approval.runId
    ? `${telegramCode(approval.runId)}${context.run?.status ? ` (${htmlEscape(context.run.status)})` : ""}`
    : "No run attached";
  return [
    `<b>${htmlEscape(env.instanceName)} approval requested</b>`,
    "",
    "<b>Thing being approved</b>",
    "<b>Proposed change</b>",
    `<pre>${htmlEscape(proposedChange)}</pre>`,
    "",
    "<b>Decision / action</b>",
    htmlEscape(proposedAction),
    "",
    "<b>Workflow</b>",
    htmlEscape(workflow),
    "",
    telegramLabeledLine("Originator", context.requestedBy || "unknown"),
    context.project?.display ? telegramLabeledLine("Project / repo / path", truncate(context.project.display, 180)) : "",
    branchLine,
    context.deploy == null ? "" : telegramLabeledLine("Deploy", context.deploy ? "yes" : "no"),
    "",
    "<b>Run</b>",
    runLine,
    telegramLabeledLine("Approval", approval.id),
    "",
    "Use the buttons below to decide."
  ]
    .filter(Boolean)
    .join("\n");
}

function telegramApprovalOpenButton(target, approvalUrl) {
  if (target.private) return { text: "Open approval", web_app: { url: approvalUrl } };
  return { text: "Open approval", url: approvalUrl };
}

function isRunStartApproval(approval) {
  const payload = approval?.payload || {};
  const kind = String(payload.approvalKind || payload.kind || "").toLowerCase();
  const scope = String(payload.approvalScope || payload.scope || "").toLowerCase();
  if (kind || scope) return kind === "run_start" || scope === "workflow_start";

  return Boolean(approval?.runId && payload.capability && payload.input && /^Approve\b/.test(approval.title || ""));
}

function runStartApprovalPolicy(approval) {
  const payload = approval?.payload || {};
  const run = approval?.runId ? getRun(approval.runId) : null;
  const capabilitySlug = payload.capability || run?.capabilitySlug || "";
  return capabilitySlug ? getCapability(capabilitySlug)?.approvalPolicy || {} : {};
}

function shouldNotifyTelegram(approval) {
  if (!approval) return false;
  if (!isRunStartApproval(approval)) return true;
  return approvalPolicyNotifiesTelegram(runStartApprovalPolicy(approval));
}

async function notifyTelegram(approval) {
  const target = telegramApprovalTarget();
  if (!env.telegramBotToken || !target) return;
  if (!shouldNotifyTelegram(approval)) return;
  const approvalUrl = absoluteDeepLink(deepLinks.approval(approval.id));
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        ...(target.threadId ? { message_thread_id: target.threadId } : {}),
        text: telegramApprovalText(approval),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [telegramApprovalOpenButton(target, approvalUrl)],
            [
              { text: "Approve", callback_data: `approval:approve:${approval.id}` },
              { text: "Request changes", callback_data: `approval:request_changes:${approval.id}` },
              { text: "Reject", callback_data: `approval:reject:${approval.id}` }
            ]
          ]
        }
      })
    });
    if (!response.ok) console.error("Telegram notification failed:", response.status);
  } catch (error) {
    console.error("Telegram notification failed:", error.message);
  }
}

function parseTelegramApprovalCallback(data) {
  if (typeof data !== "string" || !data.trim()) return { ok: false, code: 400, error: "missing callback data" };
  const parts = data.split(":");
  let action = "";
  let approvalId = "";
  if (parts.length === 2) {
    [action, approvalId] = parts;
  } else if (parts.length === 3 && parts[0] === "approval") {
    [, action, approvalId] = parts;
  } else {
    return { ok: false, code: 400, error: "invalid callback data format" };
  }
  const normalizedAction = action.replace(/-/g, "_");
  if (!["approve", "reject", "request_changes", "changes_requested", "changes"].includes(normalizedAction)) {
    return { ok: false, code: 400, error: "invalid approval decision" };
  }
  if (!/^appr_[a-f0-9]{20}$/.test(approvalId)) return { ok: false, code: 400, error: "invalid approval id" };
  return {
    ok: true,
    approvalId,
    decision: normalizedAction === "approve" ? "approved" : normalizedAction === "reject" ? "rejected" : "changes_requested"
  };
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
  const payload = callback.inline_message_id
    ? { inline_message_id: callback.inline_message_id, reply_markup: { inline_keyboard: [] } }
    : callback.message?.chat?.id && callback.message?.message_id
      ? {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] }
        }
      : null;
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

function approvalDecisionLabel(decision) {
  if (decision === "approved") return "Approved";
  if (decision === "changes_requested") return "Changes requested";
  return "Rejected";
}

app.use((req, res, next) => {
  const appSurface = req.path === "/app";
  const frameAncestors = appSurface ? "'self' https://web.telegram.org https://*.telegram.org" : "'none'";
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  if (!appSurface) res.setHeader("x-frame-options", "DENY");
  res.setHeader(
    "content-security-policy",
    `default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'self'; object-src 'none'`
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
  res.type("text/plain").send(`# Runyard (codebase: smithers-hub)

Runyard is a self-hosted control plane for agent runs. Agents discover
capabilities over MCP/CLI/HTTP, runners execute them, and the Hub stores
the durable record of logs, events, artifacts, approvals, skills, agents,
and knowledge. One private deployment per company/org.

Primary agent interface:
- MCP server: smithers-hub-mcp
- HTTP API: ${publicUrl(req)}/api
- OpenAPI: ${publicUrl(req)}/openapi.json
- Menu: ${publicUrl(req)}/api/menu
- Capability catalog: ${publicUrl(req)}/api/capabilities
- Setup docs: ${publicUrl(req)}/docs

Core tools:
- get_menu
- list_capabilities
- search_capabilities
- describe_capability
- run_capability (pass executionMode "local" or "remote")
- get_run_status
- get_run_logs
- get_run_artifacts
- list_runners
- list_pending_approvals
- approve_run
- reject_run
- request_changes_run
- cancel_run
- search_artifacts
- list_agents
- list_skills
- search_knowledge

Authenticate with a Hub access token using Bearer auth. Tokens can be
scoped (api, mcp, approvals); the first one is written to
data/bootstrap-token.txt on the server's machine on first boot.

Run path:
1. Discover with get_menu/list_capabilities.
2. Choose local or remote execution.
3. Start with run_capability or smithers-hub run --where local|remote.
4. Fetch status, logs, outputs, and artifacts from the Hub.
`);
});

app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: { title: "Runyard API (smithers-hub)", version: "0.1.0" },
    servers: [{ url: `${publicUrl(req)}/api` }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: {
      "/capabilities": { get: { summary: "List capabilities" }, post: { summary: "Create/update capability" } },
      "/capabilities/{id}": { get: { summary: "Describe capability" }, patch: { summary: "Update capability" } },
      "/capabilities/{id}/run": { post: { summary: "Run capability with optional executionMode local|remote" } },
      "/menu": { get: { summary: "Discover the Runyard MCP/CLI menu and local/remote run path" } },
      "/runs": { get: { summary: "List runs" } },
      "/runs/{id}": { get: { summary: "Get run" } },
      "/runs/{id}/events": { get: { summary: "Get run events" }, post: { summary: "Append run event" } },
      "/runs/{id}/artifacts": { get: { summary: "List run artifacts" }, post: { summary: "Upload artifact" } },
      "/approvals": { get: { summary: "List approvals" } },
      "/approvals/{id}/approve": { post: { summary: "Approve request" } },
      "/approvals/{id}/reject": { post: { summary: "Reject request" } },
      "/approvals/{id}/request-changes": { post: { summary: "Request changes" } },
      "/runners/register": { post: { summary: "Register runner" } },
      "/runners/{id}/next-run": { get: { summary: "Claim next run for runner" } }
    }
  });
});

app.get("/api/menu", requireAuth, requireScopes("api", "mcp"), (req, res) => {
  res.json(hubMenuPayload(req));
});

app.get("/api/setup", (_req, res) => {
  const telegramTarget = telegramApprovalTarget();
  res.json({
    instanceName: env.instanceName,
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
  const verified = verifyTelegramWebAppInitData(req.body.initData || "");
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

// --- Workflow source + graph ------------------------------------------------
// Serves the actual workflow code (the source-of-truth template authored in
// `workflow-templates/workflows/<slug>.tsx`) together with a parsed metadata
// header and a first-pass workflow graph derived from the JSX structure. The
// Hub code viewer and the ReactFlow visualizer both consume this endpoint —
// Smithers source remains the source of truth and the canvas is a renderer.
app.get("/api/capabilities/:id/source", requireAuth, (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability) return res.status(404).json({ error: "capability not found" });
  const source = loadWorkflowSource(capability);
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

const WORKFLOW_TEMPLATES_DIR = path.resolve(env.root, "workflow-templates", "workflows");
const WORKFLOW_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

// Map a registered capability to the on-disk workflow source. We look at the
// configured workflow.entry first (just the basename, sanitized to a slug to
// keep this away from filesystem-traversal), then fall back to <slug>.tsx.
function loadWorkflowSource(capability) {
  const candidates = workflowSourceCandidates(capability);
  for (const candidate of candidates) {
    const absolute = path.resolve(WORKFLOW_TEMPLATES_DIR, candidate);
    if (!absolute.startsWith(WORKFLOW_TEMPLATES_DIR + path.sep)) continue;
    if (!existsSync(absolute)) continue;
    const code = readFileSync(absolute, "utf8");
    const ext = path.extname(absolute).slice(1).toLowerCase();
    return {
      absolutePath: absolute,
      relativePath: path.relative(env.root, absolute),
      language: ext || "txt",
      code
    };
  }
  return null;
}

function workflowSourceCandidates(capability) {
  const slug = String(capability.slug || "").trim();
  const candidates = [];
  const entry = capability?.workflow?.entry || capability?.workflow?.path || "";
  if (typeof entry === "string" && entry.trim()) {
    const safeBase = path.basename(entry.trim());
    if (/^[A-Za-z0-9_.-]+$/.test(safeBase)) candidates.push(safeBase);
    const slugFromEntry = safeBase.replace(/\.(tsx|jsx|ts|js)$/i, "");
    if (slugFromEntry && /^[A-Za-z0-9_.-]+$/.test(slugFromEntry)) {
      for (const ext of WORKFLOW_EXTENSIONS) candidates.push(`${slugFromEntry}${ext}`);
    }
  }
  if (slug && /^[A-Za-z0-9_-]+$/.test(slug)) {
    for (const ext of WORKFLOW_EXTENSIONS) candidates.push(`${slug}${ext}`);
  }
  return Array.from(new Set(candidates));
}

// Header tags such as `// smithers-display-name: Hello (proof)` are how the
// workflow authors annotate their templates. We parse those leading comments
// only so we never pick up keys from the implementation body.
function parseWorkflowMetadata(code) {
  const out = {};
  const lines = String(code || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("//")) {
      const match = line.match(/^\/\/\s*smithers-([a-z][a-z0-9-]*)\s*:\s*(.*)$/i);
      if (match) {
        out[camelCase(match[1])] = match[2].trim();
        continue;
      }
      continue;
    }
    if (line.startsWith("/*") || line.startsWith("/**")) continue;
    if (line.startsWith("*")) continue;
    break;
  }
  return out;
}

function camelCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Split the file into Code / Agents / workflowGraph virtual tabs without
// rewriting it: each section returns a {start,end} line range plus the
// extracted text. The full file is always returned under `code` so a viewer
// can stay one document while still surfacing the meaningful pieces.
function sliceWorkflowSections(code) {
  const lines = String(code || "").split(/\r?\n/);
  const sections = {
    code: { startLine: 1, endLine: lines.length, text: code },
    agents: collectLineRanges(lines, [
      /\bnew\s+ClaudeCodeAgent\b/,
      /\bnew\s+CodexCLIAgent\b/,
      /\bnew\s+[A-Z][A-Za-z0-9_]*Agent\b/,
      /\bagent\s*[:=]/,
      /providers\.[a-z]+/
    ]),
    workflowGraph: collectLineRanges(lines, [
      /<Workflow\b/,
      /<\/Workflow>/,
      /<Sequence\b/,
      /<\/Sequence>/,
      /<Parallel\b/,
      /<\/Parallel>/,
      /<Task\b/,
      /<\/Task>/,
      /<Loop\b/,
      /<\/Loop>/
    ])
  };
  return sections;
}

function collectLineRanges(lines, patterns) {
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (patterns.some((re) => re.test(lines[i]))) hits.push(i);
  }
  if (!hits.length) return { startLine: 0, endLine: 0, text: "" };
  // Merge consecutive line numbers (within a 2-line gap) into contiguous spans.
  const spans = [];
  for (const index of hits) {
    const last = spans[spans.length - 1];
    if (last && index - last.end <= 2) last.end = index;
    else spans.push({ start: index, end: index });
  }
  const out = spans
    .map(({ start, end }) => {
      const from = Math.max(0, start - 1);
      const to = Math.min(lines.length - 1, end + 1);
      return `// L${from + 1}-${to + 1}\n${lines.slice(from, to + 1).join("\n")}`;
    })
    .join("\n\n");
  return { startLine: spans[0].start + 1, endLine: spans[spans.length - 1].end + 1, text: out };
}

const TASK_ID_RE = /<Task\b[^>]*?\bid=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\}|`([^`]+)`)/;
const TASK_AGENT_RE = /\bagent=\{([A-Za-z0-9_.()\s,]+)\}/;
const TASK_OUTPUT_RE = /\boutput=\{([A-Za-z0-9_.\s,]+)\}/;
const TASK_RETRIES_RE = /\bretries=\{(\d+)\}/;
const TASK_TIMEOUT_RE = /\btimeoutMs=\{([^}]+)\}/;
const KEYWORDS = {
  approval: /\bApproval\b|approvalKind|createApproval/,
  deploy: /\bdeploy\b|caddy|systemctl/i,
  test: /\bpnpm[\s,]*\[?\s*['"]test['"]|\bpnpm test\b|\btest\b.*passed/i,
  commit: /\bgit[^"]*commit\b|\bcommit\b.*hash/i,
  push: /\bgit push\b|\bpush\b.*origin/i,
  build: /\bpnpm[\s,]*\[?\s*['"]build['"]|\bbuild\b/i
};

// Walks the file once, tracking Sequence/Parallel nesting so each Task knows
// which container it lives in. The result is a {nodes,edges} pair shaped for
// the ReactFlow visualizer; SVG fallback consumes the same structure.
function deriveWorkflowGraph(code, capability = {}) {
  const lines = String(code || "").split(/\r?\n/);
  const stack = [];
  const containers = [];
  const tasks = [];
  let workflowName = capability?.name || "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const wfOpen = line.match(/<Workflow\b[^>]*\bname=(?:"([^"]+)"|\{`([^`]+)`\})/);
    if (wfOpen) workflowName = wfOpen[1] || wfOpen[2] || workflowName;
    if (/<Sequence\b/.test(line)) {
      const container = { kind: "sequence", id: `seq-${containers.length + 1}`, line: i + 1 };
      containers.push(container);
      stack.push(container);
    }
    if (/<Parallel\b/.test(line)) {
      const concurrency = (line.match(/maxConcurrency=\{?([^},\s>]+)\}?/) || [])[1] || "";
      const container = { kind: "parallel", id: `par-${containers.length + 1}`, line: i + 1, concurrency };
      containers.push(container);
      stack.push(container);
    }
    if (/<\/Parallel>/.test(line) || /<\/Sequence>/.test(line)) stack.pop();
    const taskMatch = line.match(TASK_ID_RE);
    if (taskMatch) {
      const rawId = taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4] || `task-${tasks.length + 1}`;
      // Tasks created inside a .map can use template literals like
      // `audit-${i + 1}` for their id — collapse those into a single readable
      // lane label rather than leaking the interpolation syntax into the graph.
      const taskId = rawId.replace(/\$\{[^}]+\}/g, "N").replace(/\s+/g, "");
      const agent = pickAgent(line);
      const output = (line.match(TASK_OUTPUT_RE) || [])[1] || "";
      const retries = (line.match(TASK_RETRIES_RE) || [])[1] || "";
      const timeout = (line.match(TASK_TIMEOUT_RE) || [])[1] || "";
      const container = stack[stack.length - 1] || null;
      const block = readTaskBlock(lines, i);
      tasks.push({
        id: taskId,
        line: i + 1,
        agent,
        output,
        retries,
        timeout,
        container,
        kind: classifyTask(taskId, block)
      });
    }
  }

  const nodes = [];
  const edges = [];
  const workflowNodeId = "workflow";
  nodes.push({
    id: workflowNodeId,
    type: "entry",
    label: workflowName || capability?.name || capability?.slug || "Workflow",
    kind: "entry",
    sublabel: capability?.workflow?.engine ? `engine ${capability.workflow.engine}` : ""
  });

  // Track the "previous frontier" — set of nodes that feed into the next task.
  let frontier = [workflowNodeId];
  let openParallel = null;
  let parallelFanIn = [];

  for (const task of tasks) {
    nodes.push({
      id: task.id,
      type: task.kind,
      label: task.id,
      kind: task.kind,
      agent: task.agent,
      output: task.output,
      retries: task.retries,
      timeout: task.timeout,
      line: task.line,
      sublabel: taskSublabel(task)
    });
    if (task.container?.kind === "parallel") {
      if (openParallel !== task.container.id) {
        // Close any previous parallel fan-in (becomes the new frontier).
        if (parallelFanIn.length) frontier = parallelFanIn;
        openParallel = task.container.id;
        parallelFanIn = [];
      }
      for (const src of frontier) edges.push(edgeBetween(src, task.id, task.container));
      parallelFanIn.push(task.id);
    } else {
      if (parallelFanIn.length) {
        frontier = parallelFanIn;
        parallelFanIn = [];
        openParallel = null;
      }
      for (const src of frontier) edges.push(edgeBetween(src, task.id, task.container));
      frontier = [task.id];
    }
  }
  if (parallelFanIn.length) frontier = parallelFanIn;

  const requiredAgents = capability?.requiredAgents || [];
  const requiredSkills = capability?.requiredSkills || [];
  const runnerTags = capability?.requiredRunnerTags || [];
  const sideNodes = [];
  for (const agent of requiredAgents) {
    sideNodes.push({ id: `agent:${agent}`, type: "agent", label: agent, kind: "agent" });
  }
  for (const skill of requiredSkills) {
    sideNodes.push({ id: `skill:${skill}`, type: "skill", label: skill, kind: "skill" });
  }
  for (const tag of runnerTags) {
    sideNodes.push({ id: `tag:${tag}`, type: "tag", label: tag, kind: "tag" });
  }

  return {
    name: workflowName || capability?.name || capability?.slug || "Workflow",
    nodes,
    edges,
    sideNodes,
    metadata: {
      taskCount: tasks.length,
      parallelGroups: containers.filter((c) => c.kind === "parallel").length,
      sequenceGroups: containers.filter((c) => c.kind === "sequence").length
    }
  };
}

function deriveWorkflowGraphFromMetadata(capability = {}) {
  const nodes = [
    {
      id: "workflow",
      type: "entry",
      kind: "entry",
      label: capability?.name || capability?.slug || "Workflow",
      sublabel: capability?.workflow?.engine ? `engine ${capability.workflow.engine}` : ""
    },
    {
      id: "execute",
      type: "task",
      kind: "task",
      label: capability?.workflow?.entry || capability?.workflow?.name || "execute",
      sublabel: capability?.category || ""
    }
  ];
  const edges = [{ id: "e-workflow-execute", source: "workflow", target: "execute", kind: "sequence" }];
  const sideNodes = [];
  for (const agent of capability?.requiredAgents || []) sideNodes.push({ id: `agent:${agent}`, type: "agent", kind: "agent", label: agent });
  for (const skill of capability?.requiredSkills || []) sideNodes.push({ id: `skill:${skill}`, type: "skill", kind: "skill", label: skill });
  for (const tag of capability?.requiredRunnerTags || []) sideNodes.push({ id: `tag:${tag}`, type: "tag", kind: "tag", label: tag });
  return { name: capability?.name || capability?.slug || "Workflow", nodes, edges, sideNodes, metadata: { taskCount: 1, parallelGroups: 0, sequenceGroups: 1 } };
}

function pickAgent(line) {
  const match = line.match(TASK_AGENT_RE);
  if (!match) return "";
  return match[1].trim().replace(/\s+/g, " ");
}

function edgeBetween(source, target, container) {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    kind: container?.kind || "sequence",
    container: container?.id || ""
  };
}

function readTaskBlock(lines, startIndex) {
  let depth = 0;
  let lineCount = 0;
  const out = [];
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 60); i += 1) {
    const line = lines[i];
    out.push(line);
    if (/<Task\b/.test(line)) depth += 1;
    if (/<\/Task>/.test(line) || (/\/>\s*$/.test(line) && depth > 0 && i !== startIndex - 1)) depth -= 1;
    lineCount += 1;
    if (depth <= 0 && lineCount > 1) break;
  }
  return out.join("\n");
}

function classifyTask(id, block) {
  // Names beat content: a task literally named `deploy` is a deploy step, even
  // if its prompt happens to mention testing or commits. Falling back to the
  // body covers tasks with generic ids ("step3") that still do recognisable
  // work like calling systemctl/caddy or running pnpm test.
  const idText = String(id || "").toLowerCase();
  if (/(^|[-_])approval|approvals?$/.test(idText)) return "approval";
  if (/(^|[-_])deploy|deploys?$/.test(idText)) return "deploy";
  if (/(^|[-_])(test|tests|verify|gate)$/.test(idText)) return "test";
  if (/(^|[-_])commit$/.test(idText)) return "commit";
  if (/(^|[-_])push$/.test(idText)) return "push";
  if (/(^|[-_])build$/.test(idText)) return "build";
  const text = String(block || "").toLowerCase();
  if (/\bapprovalkind|createapproval|requestapproval/.test(text)) return "approval";
  if (/\bsystemctl|caddy|reload|restart/.test(text)) return "deploy";
  if (KEYWORDS.test.test(text)) return "test";
  if (KEYWORDS.commit.test(text)) return "commit";
  if (KEYWORDS.push.test(text)) return "push";
  if (KEYWORDS.build.test(text)) return "build";
  if (/\bverif/.test(text)) return "verify";
  return "task";
}

function taskSublabel(task) {
  const bits = [];
  if (task.agent) bits.push(`agent ${task.agent}`);
  if (task.retries) bits.push(`retries=${task.retries}`);
  if (task.output) bits.push(`out=${task.output}`);
  if (task.container?.kind === "parallel") bits.push("parallel lane");
  return bits.join(" · ");
}

app.patch("/api/capabilities/:id", requireAuth, requireScopes("admin"), (req, res) => {
  const existing = getCapability(req.params.id);
  if (!existing) return res.status(404).json({ error: "capability not found" });
  res.json({ capability: upsertCapability({ ...existing, ...req.body, slug: existing.slug }) });
});

app.post("/api/capabilities/:id/run", requireAuth, requireScopes("api", "mcp"), async (req, res) => {
  const capability = getCapability(req.params.id);
  if (!capability || !capability.enabled) return res.status(404).json({ error: "capability not found" });
  const input = req.body.input || req.body || {};
  if (Array.isArray(req.body.chain) && input && typeof input === "object" && !Array.isArray(input)) {
    input.__chain = normalizeChainSteps(req.body.chain);
    input.__chainIndex = 0;
  }
  const execution = normalizeExecutionIntent(input, req.body || {});
  const origin = requestOrigin(req, input);
  const run = createRun(capability, input, {
    runnerId: req.body.runnerId,
    requestedBy: origin.requestedBy,
    origin: origin.origin,
    execution
  });
  const pending = listApprovals("pending").find((approval) => approval.runId === run.id);
  if (pending) await notifyTelegram(pending);
  res.status(202).json({
    run: withRunLinks(run),
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
});

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
  // Optional capability filter — used by the workflow detail page to list
  // recent runs for a single workflow. We filter in memory (run volumes are
  // already capped by the DB layer) to keep the SQL surface small.
  const capability = req.query.capability || req.query.capabilitySlug || "";
  let rows = listRuns({ status, limit: capability ? Math.max(limit, 200) : limit });
  if (capability) rows = rows.filter((r) => r.capabilitySlug === capability).slice(0, limit);
  // Queue position is computed against the global queued backlog (not the
  // filtered page) so the chip "in queue · 3 of 7" stays accurate regardless
  // of how the caller slices the list.
  const queueIndex = buildQueueIndex(status === "queued" ? rows : listRuns({ status: "queued", limit: 500 }));
  res.json({
    runs: rows.map((run) => withRunLinks(run, queueIndex)),
    total: capability ? rows.length : countRuns({ status }),
    limit,
    pool: runnerPoolStats(),
    ...(capability ? { capability } : {})
  });
});
app.get("/api/runs/:id", requireAuth, (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  const events = listRunEvents(run.id);
  const artifacts = listArtifacts({ runId: run.id }).map(withArtifactLinks);
  res.json({
    run: decorateSingleRun(run),
    events,
    artifacts,
    diagnostics: runDiagnostics(run, events, artifacts),
    logSummary: summarizeRunEvents(events),
    pool: runnerPoolStats()
  });
});
app.get("/api/runs/:id/events", requireAuth, (req, res) => res.json({ events: listRunEvents(req.params.id) }));
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
  const nextInput = {
    ...(next.input || {}),
    __chain: chain,
    __chainIndex: index + 1,
    previousRun: {
      id: parentRun.id,
      capabilitySlug: parentRun.capabilitySlug,
      capabilityName: parentRun.capabilityName,
      status: parentRun.status,
      deepLink: deepLinks.run(parentRun.id)
    }
  };
  if (next.passPreviousOutput !== false) nextInput.previousOutput = output || parentRun.output || null;
  const origin = requestOrigin(req, {
    origin: {
      label: `Chained from ${parentRun.capabilitySlug} ${parentRun.id}`,
      type: "workflow-chain",
      parentRunId: parentRun.id,
      chainIndex: index + 1,
      chainLength: chain.length
    }
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

app.post("/api/runs/:id/complete", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const output = req.body.output || {};
  const result = transitionRun(req.params.id, "succeeded", { current_step: "completed", output, completed_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (!result.idempotent) addRunEvent(req.params.id, "run.succeeded", "Run completed");
  const chainedRun = result.idempotent ? null : queueNextChainedRun(result.run, output, req);
  if (!result.idempotent) recordRunTerminalArtifacts(result.run.id);
  res.json({ run: result.run, chainedRun: chainedRun ? withRunLinks(chainedRun) : null });
});
app.post("/api/runs/:id/fail", requireAuth, requireScopes("runner"), requireRunOwnerOrAdmin, (req, res) => {
  const result = transitionRun(req.params.id, "failed", { current_step: "failed", error: req.body.error || "failed", completed_at: now() });
  if (!result.ok) return res.status(result.code).json({ error: result.error });
  if (!result.idempotent) addRunEvent(req.params.id, "run.failed", req.body.error || "Run failed");
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

app.post("/api/runs/:id/rerun", requireAuth, requireScopes("api", "mcp"), async (req, res) => {
  const previous = getRun(req.params.id);
  if (!previous) return res.status(404).json({ error: "run not found" });
  const capability = getCapability(previous.capabilitySlug);
  if (!capability || !capability.enabled) return res.status(404).json({ error: "capability not found" });
  const input = previous.input && typeof previous.input === "object" && !Array.isArray(previous.input) ? { ...previous.input } : {};
  delete input.__origin;
  input.rerunOf = previous.id;
  const origin = requestOrigin(req, {
    ...input,
    origin: {
      label: `Re-run from Hub of ${previous.id}`,
      type: "hub-rerun",
      previousRunId: previous.id
    }
  });
  const run = createRun(capability, input, {
    requestedBy: origin.requestedBy,
    origin: origin.origin
  });
  addRunEvent(previous.id, "run.rerun_requested", `Re-run requested as ${run.id}`, { runId: run.id });
  addRunEvent(run.id, "run.rerun_of", `Re-run of ${previous.id}`, { previousRunId: previous.id });
  const pending = listApprovals("pending").find((approval) => approval.runId === run.id);
  if (pending) await notifyTelegram(pending);
  res.status(202).json({
    run: withRunLinks(run),
    previousRun: withRunLinks(previous),
    statusUrl: `/api/runs/${run.id}`,
    webUrl: `/app#runs/${run.id}`,
    deepLink: deepLinks.run(run.id)
  });
});

app.get("/api/runs/:id/artifacts", requireAuth, (req, res) => res.json({ artifacts: listArtifacts({ runId: req.params.id }).map(withArtifactLinks) }));
function storeRunArtifact(runRecord, body = {}) {
  const workflowSlug = slugify(runRecord.capabilitySlug || runRecord.capabilityName || "workflow") || "workflow";
  const runDate = String(runRecord.createdAt || now()).slice(0, 10) || "unknown-date";
  const runDir = path.join(env.artifactDir, "runs", workflowSlug, runDate, runRecord.id);
  mkdirSync(runDir, { recursive: true });
  const safeName = String(body.name || "artifact.txt")
    .replace(/[/\\]/g, "-")
    .replace(/[\0\r\n]/g, "")
    .trim() || "artifact.txt";
  const filePath = path.join(runDir, safeName);
  const content = body.contentBase64 ? Buffer.from(body.contentBase64, "base64") : Buffer.from(String(body.content ?? ""));
  writeFileSync(filePath, content);
  const stats = statSync(filePath);
  return createArtifact({
    runId: runRecord.id,
    name: safeName,
    mimeType: body.mimeType || "application/octet-stream",
    sizeBytes: stats.size,
    path: filePath,
    metadata: body.metadata || {}
  });
}

function ensureRunRetrospectiveArtifact(runId) {
  const run = getRun(runId);
  if (!run) return null;
  const existing = listArtifacts({ runId });
  if (existing.some((artifact) => artifact.name === RUN_RETROSPECTIVE_ARTIFACT_NAME || artifact.metadata?.kind === "run-retrospective")) {
    return null;
  }
  const artifacts = existing.map(withArtifactLinks);
  const events = listRunEvents(runId);
  const linkedRun = withRunLinks(run);
  const capability = getCapability(run.capabilitySlug);
  const linkedCapability = capability ? withCapabilityLinks(capability) : null;
  const artifact = buildRunRetrospectiveArtifact({
    run: linkedRun,
    capability: linkedCapability,
    artifacts,
    logSummary: summarizeRunEvents(events),
    diagnostics: runDiagnostics(run, events, artifacts),
    generatedAt: now()
  });
  return storeRunArtifact(run, artifact);
}

function hasRunObstructionAnalysisArtifact(artifacts = []) {
  return artifacts.some(
    (artifact) =>
      artifact.name === RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME
      || artifact.metadata?.kind === "run-obstruction-analysis"
  );
}

async function ensureRunObstructionAnalysisArtifact(runId) {
  if (!obstructionAnalyzerConfigured(env)) return null;
  const run = getRun(runId);
  if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) return null;
  const existing = listArtifacts({ runId });
  if (hasRunObstructionAnalysisArtifact(existing)) return null;
  const artifacts = existing.map(withArtifactLinks);
  const events = listRunEvents(runId);
  const linkedRun = withRunLinks(run);
  const capability = getCapability(run.capabilitySlug);
  const linkedCapability = capability ? withCapabilityLinks(capability) : null;
  const artifact = await analyzeRunObstructions(
    {
      run: linkedRun,
      capability: linkedCapability,
      artifacts,
      logSummary: summarizeRunEvents(events),
      diagnostics: runDiagnostics(run, events, artifacts),
      generatedAt: now()
    },
    { config: env }
  );
  if (!artifact) return null;
  if (hasRunObstructionAnalysisArtifact(listArtifacts({ runId }))) return null;
  return storeRunArtifact(run, artifact);
}

function recordRunRetrospectiveArtifact(runId) {
  try {
    return ensureRunRetrospectiveArtifact(runId);
  } catch (error) {
    console.error(`Run retrospective artifact failed for ${runId}:`, error.message);
    addRunEvent(runId, "run.retrospective_failed", "Run retrospective artifact generation failed", {
      error: String(error.message || error).slice(0, 500)
    });
    return null;
  }
}

async function recordRunObstructionAnalysisArtifact(runId) {
  try {
    return await ensureRunObstructionAnalysisArtifact(runId);
  } catch (error) {
    console.error(`Run obstruction analysis artifact failed for ${runId}:`, redactAnalysisText(error.message || error, 500));
    addRunEvent(runId, "run.obstruction_analysis_failed", "Run obstruction analysis artifact generation failed", {
      error: redactAnalysisText(error.message || error, 500)
    });
    return null;
  }
}

function scheduleRunObstructionAnalysisArtifact(runId) {
  if (!runId || pendingObstructionAnalyses.has(runId) || !obstructionAnalyzerConfigured(env)) return;
  pendingObstructionAnalyses.add(runId);
  setImmediate(() => {
    recordRunObstructionAnalysisArtifact(runId).finally(() => {
      pendingObstructionAnalyses.delete(runId);
    });
  });
}

function recordRunTerminalArtifacts(runId) {
  const retrospective = recordRunRetrospectiveArtifact(runId);
  scheduleRunObstructionAnalysisArtifact(runId);
  return retrospective;
}

function reapStuckRunsWithRetrospectives(maxMs) {
  const runIds = reapStuckRunIds(maxMs);
  for (const runId of runIds) recordRunTerminalArtifacts(runId);
  return runIds.length;
}

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
function resolveApprovalHttp(req, res, decision) {
  const approval = getApproval(req.params.id);
  if (!approval) return res.status(404).json({ error: "approval not found" });
  if (approval.status !== "pending") return res.status(409).json({ error: "approval is not pending", approval: withApprovalLinks(approval) });
  const defaultComment =
    decision === "approved" ? "Approved from Web/API" : decision === "changes_requested" ? "Changes requested from Web/API" : "Rejected from Web/API";
  res.json({ approval: withApprovalLinks(resolveApproval(req.params.id, decision, req.token.name, req.body.comment || defaultComment)) });
}
app.post("/api/approvals/:id/approve", requireAuth, requireScopes("api", "mcp", "approvals"), (req, res) => resolveApprovalHttp(req, res, "approved"));
app.post("/api/approvals/:id/reject", requireAuth, requireScopes("api", "mcp", "approvals"), (req, res) => resolveApprovalHttp(req, res, "rejected"));
app.post("/api/approvals/:id/request-changes", requireAuth, requireScopes("api", "mcp", "approvals"), (req, res) =>
  resolveApprovalHttp(req, res, "changes_requested")
);

app.post("/api/runners/register", requireAuth, requireScopes("runner"), (req, res) => {
  const runner = registerRunner(req.body, req.token.id);
  res.json({ runner });
});
app.get("/api/runners", requireAuth, (_req, res) => {
  res.json({ runners: listRunners(), pool: runnerPoolStats() });
});
app.post("/api/runners/:id/heartbeat", requireAuth, requireScopes("runner"), (req, res) => res.json({ runner: heartbeatRunner(req.params.id, req.body) }));
app.get("/api/runners/:id/next-run", requireAuth, requireScopes("runner"), async (req, res) => {
  const { claimNextRun } = await import("./db.js");
  res.json(claimNextRun(req.params.id) || {});
});

app.post("/api/telegram/webhook", async (req, res) => {
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
    await answerTelegramCallbackQuery(callback.id, `${approvalDecisionLabel(parsed.decision)}.`);
    await clearTelegramApprovalButtons(callback);
    return res.json({ ok: true, approval: withApprovalLinks(resolved) });
  }
  res.json({ ok: true, ignored: "no callback query data" });
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
      reapStuckRunsWithRetrospectives(env.runDeadlineMs);
    } catch (error) {
      console.error("Run reaper failed:", error.message);
    }
  }, 60_000);
  reaper.unref?.();
}

export { app, notifyTelegram, parseTelegramApprovalCallback, telegramApprovalTarget, telegramApprovalText };
