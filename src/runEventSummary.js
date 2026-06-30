export const DIAGNOSTIC_STATUSES = new Set([
  "failed",
  "error",
  "cancelled",
  "rejected",
  "waiting_approval",
  "blocked_by_gate",
  "blocked_by_preflight",
  "provider_limited",
  "timed_out",
  "invalid_output",
  "infra_unavailable",
  "needs_human"
]);

const FOCUS_EVENT_PATTERNS = [
  /^run\.(?:failed|cancelled|errored|started|succeeded|created)$/i,
  /^(?:node|task|step|workflow)\.(?:started|finished|completed|failed|errored|cancelled)$/i,
  /^approval\.(?:requested|resolved|approved|rejected|changes_requested|auto_queued)$/i,
  /^Node(?:Started|Finished|Failed|Cancelled)$/,
  /^Run(?:Started|Cancelled|Failed|Succeeded)$/,
  /^Approval(?:Requested|Resolved|Approved|Rejected|ChangesRequested)$/
];

const LOG_EVENT_TYPES = new Set(["log", "stdout", "stderr", "workflow.log", "runner.log", "workflow.step"]);
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
const HIGHLIGHT_CATEGORIES = new Set(["run", "node", "approval", "agent", "step"]);
const DEFAULT_COLLAPSED_CATEGORIES = ["noise", "trace"];
const CATEGORY_ORDER = ["run", "node", "approval", "agent", "step", "log", "other", "trace", "noise"];

export function isFocusEvent(event) {
  const type = String(event?.type || "");
  return FOCUS_EVENT_PATTERNS.some((re) => re.test(type));
}

export function isLogEvent(event) {
  const type = String(event?.type || "");
  if (LOG_EVENT_TYPES.has(type)) return true;
  return /\.(?:log|stderr|stdout)$/i.test(type);
}

export function redactSnippet(value, max = 600) {
  let text = String(value ?? "");
  for (const { re, replace } of LOG_REDACTION_RULES) text = text.replace(re, replace);
  return truncate(text, max);
}

export function reverseFind(list, predicate) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (predicate(list[i])) return list[i];
  return null;
}

export function eventCategory(event) {
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

export function eventSeverity(event) {
  const type = String(event?.type || "");
  if (/(?:^|\.)(?:failed|errored|fatal|panic)$/i.test(type)) return "error";
  if (type === "stderr") return "error";
  if (/(?:^|\.)(?:cancelled|skipped|warn|warning|deprecated)$/i.test(type)) return "warn";
  const text = String(event?.message || "");
  if (ERROR_HINT_RE.test(text)) return "error";
  if (WARN_HINT_RE.test(text)) return "warn";
  return "info";
}

export function eventNode(event) {
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

export function summarizeRunEvents(events = [], { highlightCap = 40, perNodeCap = 6 } = {}) {
  if (!events.length) return emptyRunEventSummary();

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
    increment(categoryCounts, category);
    increment(severityCounts, severity);
    increment(typeCounts, type);
    if (severity === "error") errors += 1;
    if (severity === "warn") warnings += 1;
    if (node) recordNodeEvent(nodeStats, node, event, { severity, category, type });
    if (shouldHighlight({ category, severity, type }) && underPerNodeCap(nodeWindow, node, perNodeCap)) {
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
  }

  return {
    totals: { events: sorted.length, highlights: Math.min(highlights.length, highlightCap), errors, warnings },
    categories: sortCategoryEntries([...categoryCounts.entries()].map(([key, count]) => ({
      key,
      count,
      collapsedByDefault: DEFAULT_COLLAPSED_CATEGORIES.includes(key)
    }))),
    severities: ["error", "warn", "info"].map((key) => ({ key, count: severityCounts.get(key) || 0 })).filter((entry) => entry.count > 0),
    types: [...typeCounts.entries()].map(([key, count]) => ({ key, count, category: eventCategory({ type: key }) })).sort((a, b) => b.count - a.count).slice(0, 40),
    nodes: [...nodeStats.values()].sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || ""))).slice(0, 30),
    defaultCollapsed: DEFAULT_COLLAPSED_CATEGORIES,
    highlights: highlights.slice(-highlightCap)
  };
}

function emptyRunEventSummary() {
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

function increment(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function recordNodeEvent(nodeStats, node, event, { severity, category, type }) {
  const stat = nodeStats.get(node) || {
    node,
    total: 0,
    errors: 0,
    warnings: 0,
    lastSeverity: "info",
    lastCategory: "other",
    lastAt: event.createdAt,
    sampleType: type
  };
  stat.total += 1;
  if (severity === "error") stat.errors += 1;
  if (severity === "warn") stat.warnings += 1;
  stat.lastSeverity = severity;
  stat.lastCategory = category;
  stat.lastAt = event.createdAt;
  stat.sampleType = type;
  nodeStats.set(node, stat);
}

function shouldHighlight({ category, severity, type }) {
  return HIGHLIGHT_CATEGORIES.has(category) || severity === "error" || severity === "warn" || GATE_RE.test(type);
}

function underPerNodeCap(nodeWindow, node, cap) {
  if (!node) return true;
  const seen = nodeWindow.get(node) || 0;
  if (seen >= cap) return false;
  nodeWindow.set(node, seen + 1);
  return true;
}

function eventTypeLabel(type) {
  return String(type || "").trim() || "log";
}

function sortCategoryEntries(entries) {
  return entries.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.key);
    const bi = CATEGORY_ORDER.indexOf(b.key);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function truncate(text, max) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}
