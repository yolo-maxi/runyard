// Pure run/data helpers ported verbatim from legacy public/app.js. These are
// string/shape derivations the run cards, incident card, and filters rely on.
// Kept as plain functions (not components) so any view can reuse them.
export { formatDuration, runDurationMs, relativeTime, formatTimestamp } from "./format.js";

export const ACTIVE_STATUSES = new Set(["queued", "assigned", "running", "waiting_approval", "pending"]);
export const isActiveRun = (run) => ACTIVE_STATUSES.has(run?.status);

const DIAGNOSTIC_STATUSES = new Set(["failed", "error", "cancelled", "rejected", "waiting_approval"]);
const UNRESOLVED_FAILURE_STATUSES = new Set(["failed", "error"]);
export const isDiagnosticRun = (run) => Boolean(run && DIAGNOSTIC_STATUSES.has(run.status));
export const isUnresolvedFailure = (run) => Boolean(run && UNRESOLVED_FAILURE_STATUSES.has(run.status));

export function isSupervisedChildRun(run) {
  if (!run) return false;
  const origin = String(run.originLabel || run.origin?.label || "").toLowerCase();
  if (origin === "run-smithers wrapper") return true;
  if (origin.startsWith("run-smithers self-repair")) return true;
  const internalOrigin = run.input?.__origin;
  return Boolean(
    internalOrigin?.parentRunId &&
      String(internalOrigin?.label || "").toLowerCase().startsWith("run-smithers")
  );
}
export const topLevelRuns = (runs) => (runs || []).filter((r) => !isSupervisedChildRun(r));
export const supervisedChildRuns = (runs) => (runs || []).filter(isSupervisedChildRun);

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
  else if (status === "failed" || status === "error") outcome = "fail";
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
  { value: "waiting_approval", label: "Waiting approval" }
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

export function approvalWorkflowLabel(approval) {
  // Faithful to legacy approvalWorkflowLabel(); the dashboard's pendingApprovals
  // rows carry capabilityName/slug directly, so prefer those, then payload.
  const name = approval?.capabilityName || approval?.workflow?.name;
  const slug = approval?.capabilitySlug || approval?.workflow?.slug;
  if (!name && !slug) return approval?.payload?.capability || "Unknown workflow";
  return `${name || slug || "Workflow"}${slug && name ? ` (${slug})` : ""}`;
}
