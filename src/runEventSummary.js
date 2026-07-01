import { redactText } from "./redaction.js";
import {
  DEFAULT_COLLAPSED_CATEGORIES,
  eventCategory,
  eventNode,
  eventSeverity,
  eventTypeLabel,
  isFocusEvent,
  isLogEvent,
  sortCategoryEntries
} from "./runEventClassification.js";

export {
  eventCategory,
  eventNode,
  eventSeverity,
  isFocusEvent,
  isLogEvent
} from "./runEventClassification.js";

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

const GATE_RE = /(test|build|deploy|commit|push|gate|verify)/i;
const HIGHLIGHT_CATEGORIES = new Set(["run", "node", "approval", "agent", "step"]);

export function redactSnippet(value, max = 600) {
  return redactText(value, { max, wordBoundary: true });
}

export function reverseFind(list, predicate) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (predicate(list[i])) return list[i];
  return null;
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
