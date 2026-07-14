// Pure run/data helpers ported verbatim from legacy public/app.js. These are
// string/shape derivations the run cards, incident card, and filters rely on.
// Kept as plain functions (not components) so any view can reuse them.
export { formatDuration, runDurationMs, relativeTime, formatTimestamp } from "./format.js";

// `paused` counts as active: a paused run is in flight, parked on a
// recoverable interruption (e.g. add credits) — it groups with In flight,
// never with terminal failures.
export const ACTIVE_STATUSES = new Set(["queued", "assigned", "running", "waiting_approval", "pending", "paused"]);
export const isActiveRun = (run) => ACTIVE_STATUSES.has(run?.status);

const DIAGNOSTIC_STATUSES = new Set(["failed", "error", "cancelled", "rejected", "waiting_approval"]);
const UNRESOLVED_FAILURE_STATUSES = new Set(["failed", "error"]);
export const isDiagnosticRun = (run) => Boolean(run && DIAGNOSTIC_STATUSES.has(run.status));
export const isUnresolvedFailure = (run) => Boolean(run && UNRESOLVED_FAILURE_STATUSES.has(run.status));

export function truncate(text, max) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

const PROJECT_INPUT_KEYS = ["project", "repo", "repository", "target", "targetPath", "path", "subdomain", "preferredSubdomain"];
const BRANCH_INPUT_KEYS = ["branch", "targetBranch", "ref", "gitBranch"];
const TITLE_INPUT_KEYS = ["title", "name", "goal", "task", "prompt", "topic", "idea", "workPrompt", "question"];
const DESCRIPTION_INPUT_KEYS = ["description", "summary", "notes", "scope", "constraints", "reason", "rationale", "context"];

function firstInputString(input, keys) {
  if (!input || typeof input !== "object") return "";
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function runTitle(run) {
  if (run?.title) return run.title;
  const fromInput = firstInputString(run?.input, TITLE_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 90);
  return run?.capabilityName || run?.capabilitySlug || "Run";
}

export function runDescription(run) {
  if (run?.description) return run.description;
  const fromInput = firstInputString(run?.input, DESCRIPTION_INPUT_KEYS);
  if (fromInput) return truncate(fromInput, 240);
  const titleField = firstInputString(run?.input, TITLE_INPUT_KEYS);
  if (titleField && titleField.length > 90) return truncate(titleField, 240);
  const parts = [];
  if (run?.capabilityName) parts.push(run.capabilityName);
  if (run?.currentStep) parts.push(run.currentStep);
  return truncate(parts.join(" — "), 240);
}

export const runProject = (run) => run?.project || firstInputString(run?.input, PROJECT_INPUT_KEYS);
export const runBranch = (run) => run?.branch || firstInputString(run?.input, BRANCH_INPUT_KEYS);

// Count of files the run's outcome summary reported as changed, plus the
// underlying list for hover-tooltip context. Returns null when nothing changed
// so the Runs history row can hide the chip gracefully (older runs, non-code
// runs, and runs that succeeded without touching any tracked files). The list
// view used to show only churn — this surfaces the same "N files changed"
// signal the run detail summary shows, so operators can scan the run history
// without opening each run.
export function runChangedFiles(run) {
  const summary = run?.outcomeSummary;
  if (!summary || typeof summary !== "object") return null;
  const rawCount = Number(summary.changedFiles);
  const list = Array.isArray(summary.files) ? summary.files : [];
  const count = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : list.length;
  if (!count) return null;
  return { count, files: list };
}

// GitHub-style +additions/-deletions if the run's outcome summary reported any.
// Returns null when the workflow didn't emit churn (older runs, non-code runs,
// runs that never reached the commit gate) so the UI can hide the chip
// gracefully instead of showing "+0 -0".
export function runChurn(run) {
  const churn = run?.outcomeSummary?.churn;
  if (!churn || typeof churn !== "object") return null;
  const additions = Number(churn.additions);
  const deletions = Number(churn.deletions);
  const okAdd = Number.isFinite(additions) && additions >= 0;
  const okDel = Number.isFinite(deletions) && deletions >= 0;
  if (!okAdd || !okDel) return null;
  if (additions === 0 && deletions === 0) return null;
  return { additions, deletions };
}

// One-sentence digest of what the run produced; empty string when the backend
// couldn't derive one (old runs, no output nodes to summarize).
export function runDigest(run) {
  const digest = run?.outcomeSummary?.digest;
  return typeof digest === "string" ? digest.trim() : "";
}

export function runExecutionLabel(run) {
  const execution = run?.execution || run?.input?.__execution || {};
  const mode = execution.mode && execution.mode !== "auto" ? execution.mode : "auto";
  const location = execution.runnerLocation || "";
  if (!execution.requested && mode === "auto" && !location) return "";
  return location && mode !== "auto" ? `${mode} (${location})` : mode;
}

export function formatBytes(b) {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} kB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// --- Metered usage (run.usage aggregate written by the Hub) ------------------
export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.floor(n));
}

export function formatCostMicros(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const usd = n / 1_000_000;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(usd >= 0.01 ? 2 : 4)}`;
}

// Null when the run has no metered usage yet.
export function runUsage(run) {
  const usage = run?.usage;
  if (!usage || typeof usage !== "object") return null;
  const totalTokens = Number(usage.totalTokens) || 0;
  const costMicros = Number(usage.costMicros) || 0;
  if (totalTokens <= 0 && costMicros <= 0) return null;
  return {
    totalTokens,
    costMicros,
    calls: Number(usage.calls) || 0,
    tokensLabel: formatTokens(totalTokens),
    costLabel: formatCostMicros(costMicros),
    byModel: usage.byModel && typeof usage.byModel === "object" ? usage.byModel : {}
  };
}

// Short "12.3k tok · $0.42" chip text, or "" when unmetered.
export function runUsageChip(run) {
  const usage = runUsage(run);
  if (!usage) return "";
  const parts = [];
  if (usage.tokensLabel) parts.push(`${usage.tokensLabel} tok`);
  if (usage.costLabel) parts.push(usage.costLabel);
  return parts.join(" · ");
}

// One label map for pause reasons, shared by the run detail notice, the runs
// list chip, and the attention strip.
export const PAUSE_REASON_LABELS = {
  credits_exhausted: "Provider credits exhausted",
  quota_exhausted: "Provider quota exhausted",
  provider_limited: "Provider limited",
  manual: "Paused by an operator",
  unknown: "Paused"
};

export function pauseReasonLabel(reason) {
  return PAUSE_REASON_LABELS[reason] || PAUSE_REASON_LABELS.unknown;
}

// Budget chip for run lists. run.budgetStatus is server-computed (spent vs
// limit); this only decides when it deserves a chip: a near-limit warning
// while the run can still be saved, and the hard stop after.
export function runBudgetChip(run) {
  if (run?.status === "budget_exceeded") return { label: "Stopped at budget", tone: "stop" };
  const status = run?.budgetStatus;
  if (!status || typeof status !== "object" || !status.nearLimit) return null;
  return { label: `Budget ${status.percentUsed}% used`, tone: "warn" };
}

const MIME_EXT = {
  "text/markdown": ".md", "text/plain": ".txt", "application/json": ".json",
  "text/html": ".html", "application/pdf": ".pdf", "image/png": ".png",
  "image/jpeg": ".jpg", "image/gif": ".gif", "image/svg+xml": ".svg",
  "text/csv": ".csv", "application/zip": ".zip", "application/x-yaml": ".yaml",
  "text/x-log": ".log"
};

export function artifactDisplayName(artifact) {
  let name = (artifact?.name || "artifact").trim() || "artifact";
  const generic = /^(artifact|blob|result|output|file|data)$/i.test(name);
  const hasDot = name.includes(".");
  if ((generic || !hasDot) && artifact?.mimeType && MIME_EXT[artifact.mimeType]) {
    const ext = MIME_EXT[artifact.mimeType];
    if (!name.toLowerCase().endsWith(ext)) name = `${name}${ext}`;
  }
  if (artifact?.kind && !name.toLowerCase().startsWith(`${artifact.kind.toLowerCase()}/`)) {
    return `${artifact.kind}/${name}`;
  }
  return name;
}

// Terminal failure-class statuses (mirrors src/runFailureClass.js).
const FAILURE_RUN_STATUSES = new Set([
  "failed",
  "error",
  "blocked_by_gate",
  "blocked_by_preflight",
  "provider_limited",
  "timed_out",
  "invalid_output",
  "infra_unavailable",
  "needs_human",
  "budget_exceeded"
]);

// --- Progress strip phase logic (drives RunProgressStrip) -------------------
const STALL_THRESHOLD_MS = 10_000;

export function runPhaseStates(run, now = Date.now()) {
  const status = run?.status || "";
  const lastBeat = Date.parse(run?.lastHeartbeatAt || run?.updatedAt || run?.startedAt || run?.createdAt || "");
  const stale = Number.isFinite(lastBeat) && now - lastBeat > STALL_THRESHOLD_MS;
  const queued = status === "queued" ? "active" : "done";
  let running;
  if (status === "queued") running = "pending";
  else if (status === "running" || status === "assigned" || status === "pending") running = stale ? "stalled" : "active";
  else if (status === "waiting_approval") running = "active";
  else running = "done";
  let outcome;
  if (status === "succeeded") outcome = "ok";
  else if (FAILURE_RUN_STATUSES.has(status)) outcome = "fail";
  else if (status === "cancelled" || status === "rejected") outcome = "cancel";
  else outcome = "pending";
  return { queued, running, outcome };
}

export function runPhaseDurations(run) {
  const status = run?.status || "";
  const created = Date.parse(run?.createdAt || "");
  const started = Date.parse(run?.startedAt || "");
  const completed = Date.parse(run?.completedAt || run?.endedAt || "");
  const finiteCreated = Number.isFinite(created);
  const finiteStarted = Number.isFinite(started);
  const finiteCompleted = Number.isFinite(completed);
  const queued = { ms: null, liveStart: null };
  if (finiteCreated) {
    if (finiteStarted) queued.ms = Math.max(0, started - created);
    else if (status === "queued") queued.liveStart = created;
  }
  const running = { ms: null, liveStart: null };
  const runStart = finiteStarted ? started : finiteCreated && status !== "queued" ? created : null;
  if (runStart != null) {
    if (finiteCompleted) running.ms = Math.max(0, completed - runStart);
    else if (["running", "assigned", "pending", "waiting_approval"].includes(status)) running.liveStart = runStart;
  }
  return { queued, running, outcome: { ms: null, liveStart: null } };
}

// --- Failure summarization (plain-English incident card) --------------------
export function cleanFailureText(raw) {
  let s = String(raw || "");
  s = s.replace(/^[\s>*•-]*[A-Za-z][A-Za-z0-9_.]*(?:Error|Exception):\s*/, "");
  s = s.replace(/^(?:Node|Run|Task|Step)(?:Failed|Cancelled|Errored)\b[:\s-]*/i, "");
  s = s.replace(/\b(?:at\s+|during\s+(?:step\s+)?|on\s+)?(?:runs?|nodes?|tasks?|agents?|caps?|runners?|wf|jobs?)\b\s*[:#]?\s*(?:[A-Za-z0-9]*[-_][A-Za-z0-9]{6,}|[0-9a-f]{8}-[0-9a-f-]{8,})\b['"]?/gi, " ");
  s = s.replace(/\b[A-Za-z0-9]*_[A-Za-z0-9]{6,}\b/g, " ");
  s = s.replace(/\b(?:run|node|task|agent|job|step|cap|runner|wf)-[A-Za-z0-9]{6,}\b/gi, " ");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ");
  s = s.replace(/\b\d{9,}\b/g, " ");
  s = s.split(/\r?\n/)[0];
  s = s.replace(/[([{]\s*[)\]}]/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.,;:)])/g, "$1");
  s = s.replace(/^[\s:·,;-]+/, "").replace(/[\s:·,;-]+$/, "").trim();
  return s;
}

export function summarizeFailure(run) {
  if (!run) return null;
  const raw = String(run.error || run.reasonHint || "").trim();
  const step = String(run.failedStep || run.currentStep || "").trim();
  const GENERIC_STEPS = new Set(["", "completed", "done", "failed", "error", "errored", "cancelled", "canceled", "rejected", "queued", "running"]);
  const informativeStep = GENERIC_STEPS.has(step.toLowerCase()) ? "" : step;
  const low = raw.toLowerCase();
  let label;
  if (run.status === "rejected") label = "Approval rejected";
  else if (run.status === "cancelled") label = "Cancelled";
  else if (run.status === "budget_exceeded" || /\bbudget exceeded\b/.test(low)) label = "Stopped at budget";
  else if (/\b(?:timed?\s*out|timeout|etimedout|deadline)\b/.test(low)) label = "Timed out";
  else if (/\b(?:econnrefused|enotfound|socket hang|fetch failed|getaddrinfo)\b/.test(low) || /\bnetwork\b/.test(low)) label = "Network error";
  else if (/\b(?:type|reference|syntax|range)error\b/.test(low)) label = "Workflow code error";
  else if (/\b(?:eacces|eperm|permission|denied|unauthor|forbidden|401|403)\b/.test(low)) label = "Permission denied";
  else if (/\b(?:exit code|non-zero|command failed|enoent|spawn)\b/.test(low)) label = "Command failed";
  else if (/\bno runner\b/.test(low) || /\bheartbeat\b/.test(low) || /\brunner\b.*\b(?:offline|unavailable|lost|disconnect)/.test(low)) label = "Runner unavailable";
  else if (/\bout of memory\b|\boom\b|\bheap\b/.test(low)) label = "Out of memory";
  else if (informativeStep) label = `Failed at “${informativeStep}”`;
  else label = "Run failed";
  let sentence = cleanFailureText(raw);
  if (!sentence) {
    sentence = informativeStep
      ? `The “${informativeStep}” step stopped without a captured error message.`
      : "This run stopped before completing — open the timeline to read the failing events.";
  }
  return {
    label,
    sentence: truncate(sentence, 180),
    step: informativeStep,
    raw: truncate(raw, 600),
    runId: run.id || "",
    runnerId: run.runnerId || ""
  };
}

// --- Filter option tables ---------------------------------------------------
export const RUN_STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "waiting_approval", label: "Waiting approval" },
  { value: "paused", label: "Paused" },
  { value: "budget_exceeded", label: "Stopped at budget" }
];

export const TIME_RANGE_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" }
];

export function timeRangeToSinceISO(value) {
  if (!value) return "";
  const m = /^(\d+)([hd])$/.exec(value);
  if (!m) return "";
  const n = Number(m[1]);
  const unit = m[2] === "h" ? 3600_000 : 86_400_000;
  return new Date(Date.now() - n * unit).toISOString();
}

// Humanized run status for anywhere a person reads it (badges, diagnostics).
// Mirrors the server-side vocabulary in src/approvalPresentation.js; the raw
// enum stays in JSON and in CSS class names.
const RUN_STATUS_LABELS = {
  queued: "Queued",
  assigned: "Assigned to a runner",
  running: "Running",
  pending: "Pending",
  waiting_approval: "Waiting for approval",
  paused: "Paused",
  succeeded: "Succeeded",
  failed: "Failed",
  error: "Failed",
  cancelled: "Cancelled",
  rejected: "Rejected",
  budget_exceeded: "Stopped at budget"
};

export function runStatusLabel(status) {
  if (!status) return "";
  return RUN_STATUS_LABELS[status] || String(status).replace(/_/g, " ");
}

export function approvalWorkflowLabel(approval) {
  // Faithful to legacy approvalWorkflowLabel(); the dashboard's pendingApprovals
  // rows carry capabilityName/slug directly, so prefer those, then payload.
  const name = approval?.capabilityName || approval?.workflow?.name;
  const slug = approval?.capabilitySlug || approval?.workflow?.slug;
  if (!name && !slug) return approval?.payload?.capability || "Unknown workflow";
  return `${name || slug || "Workflow"}${slug && name ? ` (${slug})` : ""}`;
}
