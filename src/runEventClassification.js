const FOCUS_EVENT_PATTERNS = [
  /^run\.(?:failed|cancelled|errored|started|succeeded|created)$/i,
  /^(?:node|task|step|workflow)\.(?:started|finished|completed|failed|errored|cancelled)$/i,
  /^approval\.(?:requested|resolved|approved|rejected|changes_requested|auto_queued)$/i,
  /^engine\.approval\.(?:waiting|resumed|applied|apply_failed)$/i,
  /^Node(?:Started|Finished|Failed|Cancelled)$/,
  /^Run(?:Started|Cancelled|Failed|Succeeded)$/,
  /^Approval(?:Requested|Resolved|Approved|Rejected|ChangesRequested)$/
];

const LOG_EVENT_TYPES = new Set(["log", "stdout", "stderr", "workflow.log", "runner.log", "workflow.step"]);

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

const APPROVAL_EVENT_RE = /^(?:engine\.)?approval\./i;
const NODE_EVENT_RE = /^(?:node|task|step)\.(?:started|finished|completed|failed|errored|cancelled|skipped)$/i;
const RUN_EVENT_RE = /^run\.(?:created|started|succeeded|failed|cancelled|errored|chain\..*|rerun_.*)$/i;
const STEP_MARKER_RE = /^workflow\.step$/i;
const AGENT_SUMMARY_RE = /^(?:agent|claude|codex)\.(?:summary|result|completed|final)$/i;
const ERROR_HINT_RE = /(?:^|\s|:)(error|failed|panic|fatal|exception|timeout)\b/i;
const WARN_HINT_RE = /(?:^|\s|:)(warn(?:ing)?|deprecat|retrying|skipped)\b/i;

export const DEFAULT_COLLAPSED_CATEGORIES = ["noise", "trace"];
export const CATEGORY_ORDER = ["run", "node", "approval", "agent", "step", "log", "other", "trace", "noise"];

export function isFocusEvent(event) {
  const type = String(event?.type || "");
  return FOCUS_EVENT_PATTERNS.some((re) => re.test(type));
}

export function isLogEvent(event) {
  const type = String(event?.type || "");
  if (LOG_EVENT_TYPES.has(type)) return true;
  return /\.(?:log|stderr|stdout)$/i.test(type);
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

export function eventTypeLabel(type) {
  return String(type || "").trim() || "log";
}

export function sortCategoryEntries(entries) {
  return entries.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.key);
    const bi = CATEGORY_ORDER.indexOf(b.key);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}
