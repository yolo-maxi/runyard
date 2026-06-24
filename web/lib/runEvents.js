// Pure run-event classification helpers, ported verbatim from legacy app.js.
// Shared by the static run log and the live event console.

export const RUN_LOG_CATEGORY_LABELS = {
  run: "Run", node: "Node", approval: "Approval", agent: "Agent", step: "Step",
  log: "Log", other: "Other", trace: "Trace", noise: "Heartbeat"
};
export const RUN_LOG_SEVERITY_LABELS = { error: "Errors", warn: "Warnings", info: "Info" };
export const RUN_LOG_NOISY_CATEGORIES = new Set(["noise", "trace"]);

export function eventCategoryClient(event) {
  const type = String(event?.type || "");
  if (/(?:^|\.)heartbeat$|^heartbeat$|\.tick$|\.ping$/i.test(type)) return "noise";
  if (/\.(?:trace|span|delta|chunk|tool_use|tool_result|thinking)$/i.test(type)) return "trace";
  if (/^approval\./i.test(type)) return "approval";
  if (/^run\./i.test(type)) return "run";
  if (/^(?:node|task|step)\./i.test(type)) return "node";
  if (/^workflow\.step$/i.test(type)) return "step";
  if (/^(?:agent|claude|codex)\.(?:summary|result|completed|final)$/i.test(type)) return "agent";
  if (type === "log" || type === "stdout" || type === "stderr" || /\.(?:log|stdout|stderr)$/i.test(type)) return "log";
  return "other";
}

export function eventSeverityClient(event) {
  const type = String(event?.type || "");
  if (/(?:^|\.)(?:failed|errored|fatal|panic)$/i.test(type)) return "error";
  if (type === "stderr") return "error";
  if (/(?:^|\.)(?:cancelled|skipped|warn|warning|deprecated)$/i.test(type)) return "warn";
  const text = String(event?.message || "");
  if (/(?:^|\s|:)(error|failed|panic|fatal|exception|timeout)\b/i.test(text)) return "error";
  if (/(?:^|\s|:)(warn(?:ing)?|deprecat|retrying|skipped)\b/i.test(text)) return "warn";
  return "info";
}

export function eventNodeClient(event) {
  const data = event?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const field = data.node || data.nodeId || data.taskId || data.task || data.step;
    if (field) return String(field).slice(0, 80);
  }
  return "";
}

export function runLogTextDump(events) {
  return (events || []).map((event) => `[${event.createdAt}] ${event.type}: ${event.message || ""}`).join("\n");
}

// Decorate a raw event with category/severity/node — the shape the log + console
// rows render from.
export function decorateEvent(event) {
  return {
    ...event,
    category: eventCategoryClient(event),
    severity: eventSeverityClient(event),
    node: eventNodeClient(event)
  };
}
