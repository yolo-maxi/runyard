// Server-side live context for the in-app support agent.
//
// The browser only sends a thin route descriptor ({view, hash, params, ...}).
// That tells us WHERE the operator is, not WHAT they are looking at. This
// module resolves the route against the Hub database (read-only) and builds a
// compact, redacted "Live app data" block so the agent can answer questions
// like "why did this fail?" or "what's broken?" from the actual run/event
// state instead of guessing.
//
// Hard rules:
//   - Read-only. We never write through these helpers.
//   - Never emit token/secret values. Event/log text is redacted and run input
//     is summarized through `safeInput` (secret-shaped keys are dropped).
//   - Bounded. Every list is capped and every string is truncated so the block
//     stays small enough to prepend to the model prompt cheaply.

import {
  dashboardStats,
  getApproval,
  getCapability,
  getRun,
  listApprovals,
  listCapabilities,
  listRunEvents,
  listRuns,
  runnerPoolStats
} from "./db.js";

const MAX_EVENTS = 8;
const MAX_FAILING_RUNS = 6;

// Mirror of the server log-redaction rules so any event/error text we surface
// to the model doesn't carry an obvious bearer token / api key / JWT shape.
const REDACTION_RULES = [
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

const SECRET_FIELD_RE = /(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i;

function redact(value, max = 240) {
  let text = String(value ?? "");
  for (const { re, replace } of REDACTION_RULES) text = text.replace(re, replace);
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// Summarize run input for the model: a few human-meaningful keys, never any
// secret-shaped field, values redacted + truncated.
function safeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const parts = [];
  for (const [key, raw] of Object.entries(input)) {
    if (key.startsWith("__")) continue;
    if (SECRET_FIELD_RE.test(key)) continue;
    if (raw == null || raw === "") continue;
    if (typeof raw === "object") continue;
    parts.push(`${key}=${redact(raw, 120)}`);
    if (parts.length >= 6) break;
  }
  return parts.join(", ");
}

const FOCUS_EVENT_RE = /(?:^run\.|^node\.|^task\.|^step\.|^workflow\.step|^approval\.|failed|error|cancelled|succeeded|started|finished|completed)/i;
const NOISE_EVENT_RE = /(heartbeat|\.tick$|\.ping$|trace|\.delta$|\.chunk$|tool_use|tool_result|thinking)/i;

// Pull the most informative recent events for a run: prefer lifecycle / error
// transitions over the firehose of traces and heartbeats.
function recentRunEvents(runId) {
  const events = listRunEvents(runId);
  if (!events.length) return [];
  const focus = events.filter((e) => {
    const type = String(e.type || "");
    if (NOISE_EVENT_RE.test(type)) return false;
    return FOCUS_EVENT_RE.test(type) || /(error|failed|fatal|panic|exception|timeout|warn)/i.test(String(e.message || ""));
  });
  const chosen = (focus.length ? focus : events).slice(-MAX_EVENTS);
  return chosen.map((e) => ({
    type: e.type,
    message: redact(e.message, 200),
    at: e.createdAt
  }));
}

function runHeadline(run) {
  if (!run) return "";
  if (run.error) return redact(run.error, 200);
  return redact(run.currentStep || "", 160);
}

// Parse the operator's route into {view, segments}. We trust the hash (it's the
// URL bar the operator literally sees) and fall back to the explicit view.
export function parseRoute(context = {}) {
  const rawHash = String(context.hash || "").replace(/^#/, "");
  let segments = rawHash ? rawHash.split("/").filter(Boolean) : [];
  if (!segments.length && Array.isArray(context.segments)) {
    segments = context.segments.map((s) => String(s)).filter(Boolean);
  }
  let view = String(context.view || segments[0] || "").toLowerCase();
  // Normalize the handful of aliases the router accepts.
  if (view === "dashboard" || view === "") view = "home";
  if (view === "capabilities") view = "workflows";
  return { view, segments, hash: rawHash };
}

function describeRun(run) {
  const lines = [];
  lines.push(`Run ${run.id} — ${run.capabilityName || run.capabilitySlug || "workflow"}`);
  lines.push(`Status: ${run.status}${run.currentStep ? ` (step: ${redact(run.currentStep, 80)})` : ""}`);
  const headline = runHeadline(run);
  if (headline && headline !== run.currentStep) lines.push(`Detail: ${headline}`);
  const inputSummary = safeInput(run.input);
  if (inputSummary) lines.push(`Input: ${inputSummary}`);
  if (run.createdAt) lines.push(`Created: ${run.createdAt}`);
  if (run.completedAt) lines.push(`Completed: ${run.completedAt}`);
  const events = recentRunEvents(run.id);
  if (events.length) {
    lines.push("Recent events:");
    for (const e of events) lines.push(`  • ${e.type}: ${e.message || "(no message)"}`);
  }
  return lines.join("\n");
}

function describeRunsList() {
  const stats = dashboardStats();
  const pool = runnerPoolStats();
  const failing = listRuns({ status: "failed", limit: MAX_FAILING_RUNS });
  const lines = [];
  lines.push(
    `Runs overview — ${stats.runs} total · ${stats.runningRuns} active ` +
    `(${pool.queued} queued, ${pool.running} running, ${pool.waitingApproval} waiting approval) · ` +
    `${stats.pendingApprovals} pending approval${stats.pendingApprovals === 1 ? "" : "s"}.`
  );
  lines.push(
    `Runner pool: ${pool.onlineRunners} online, ${pool.availableSlots}/${pool.totalCapacity} slots free.`
  );
  if (failing.length) {
    lines.push(`Recent failed runs (${failing.length}):`);
    for (const run of failing) {
      lines.push(`  • ${run.id} ${run.capabilitySlug || ""} — ${runHeadline(run) || "failed"}`);
    }
  } else {
    lines.push("No failed runs on record.");
  }
  return lines.join("\n");
}

function describeWorkflow(slug) {
  const cap = getCapability(slug);
  if (!cap) return `Workflow "${slug}" was not found in this Hub.`;
  const recent = listRuns({ q: cap.slug, limit: 5 }).filter((r) => r.capabilitySlug === cap.slug);
  const lines = [];
  lines.push(`Workflow ${cap.name || cap.slug} (slug: ${cap.slug})`);
  if (cap.category) lines.push(`Category: ${cap.category}`);
  if (cap.description) lines.push(`Description: ${redact(cap.description, 360)}`);
  if (cap.requiredRunnerTags?.length) lines.push(`Required runner tags: ${cap.requiredRunnerTags.join(", ")}`);
  if (recent.length) {
    lines.push("Recent runs:");
    for (const run of recent) lines.push(`  • ${run.id} — ${run.status}`);
  }
  return lines.join("\n");
}

function describeWorkflowsList() {
  const caps = listCapabilities();
  const lines = [`Workflows catalog — ${caps.length} installed.`];
  for (const cap of caps.slice(0, 14)) {
    lines.push(`  • ${cap.slug}${cap.category ? ` [${cap.category}]` : ""} — ${redact(cap.description || cap.name || "", 80)}`);
  }
  return lines.join("\n");
}

function describeApprovals(segments) {
  const id = segments[1];
  if (id) {
    const approval = getApproval(id);
    if (!approval) return `Approval "${id}" was not found.`;
    const lines = [`Approval ${approval.id} — status ${approval.status}`];
    if (approval.title) lines.push(`Title: ${redact(approval.title, 160)}`);
    if (approval.runId) lines.push(`Run: ${approval.runId}`);
    if (approval.comment) lines.push(`Comment: ${redact(approval.comment, 240)}`);
    return lines.join("\n");
  }
  const pending = listApprovals("pending");
  const lines = [`Pending approvals — ${pending.length}.`];
  for (const approval of pending.slice(0, 8)) {
    lines.push(`  • ${approval.id} — ${redact(approval.title || approval.runId || "approval", 120)}`);
  }
  return lines.join("\n");
}

function describeRunners() {
  const pool = runnerPoolStats();
  return [
    `Runner pool — ${pool.onlineRunners}/${pool.runners} online.`,
    `Capacity: ${pool.totalActive}/${pool.totalCapacity} slots in use, ${pool.availableSlots} free.`,
    `Queue: ${pool.queued} queued, ${pool.running} running, ${pool.waitingApproval} waiting approval.`
  ].join("\n");
}

// Build the live-context text block. Returns { text, kind } where kind is the
// resolved subject so callers can log/branch. Never throws — any DB hiccup
// degrades to an empty block so chat still works.
export function buildSupportLiveContext(context = {}) {
  try {
    const { view, segments } = parseRoute(context);
    if (view === "runs" || view === "home") {
      const runId = view === "runs" ? segments[1] : "";
      if (runId) {
        const run = getRun(runId);
        if (run) return { kind: "run", text: describeRun(run) };
        return { kind: "run-missing", text: `Run "${runId}" was not found in this Hub.` };
      }
      return { kind: "runs", text: describeRunsList() };
    }
    if (view === "workflows") {
      const slug = segments[1];
      if (slug) return { kind: "workflow", text: describeWorkflow(slug) };
      return { kind: "workflows", text: describeWorkflowsList() };
    }
    if (view === "approvals") return { kind: "approvals", text: describeApprovals(segments) };
    if (view === "runners") return { kind: "runners", text: describeRunners() };
    return { kind: view || "unknown", text: "" };
  } catch {
    return { kind: "error", text: "" };
  }
}

export const __test = { parseRoute, safeInput, redact, recentRunEvents, describeRun, buildSupportLiveContext };
