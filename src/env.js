import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseBool, parseTrustProxy } from "./configParsing.js";
import {
  defaultDbPath,
  deriveEnvironmentLabel,
  deriveHostnameLabel,
  firstEnv as firstEnvValue,
  resolveSessionSecret
} from "./envConfig.js";

export { defaultDbPath } from "./envConfig.js";

// Read the first non-empty value among the given env var names. RunYard prefers
// its RUNYARD_HUB_* variables but falls back to the legacy SMITHERS_HUB_* names
// so existing deployments and tokens keep working without any re-config.
export function firstEnv(...names) {
  return firstEnvValue(process.env, ...names);
}

// Single source of truth for the app version: package.json. Bumping it there now
// flows to /api/version, /version, the OpenAPI doc, the CLI, MCP serverInfo, and
// the update-available check — instead of the old hardcoded "0.1.1" that drifted
// across four files and left every release showing a permanent update badge.
export const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return (pkg && typeof pkg.version === "string" && pkg.version) || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const root = firstEnv("RUNYARD_HUB_ROOT", "SMITHERS_HUB_ROOT") || process.cwd();
const dataDir = firstEnv("RUNYARD_HUB_DATA_DIR", "SMITHERS_HUB_DATA_DIR") || path.join(root, "data");

mkdirSync(dataDir, { recursive: true });
mkdirSync(path.join(dataDir, "artifacts", "runs"), { recursive: true });

// Default DB path. Canonical file is runyard.sqlite, but a legacy
// smithers-hub.sqlite must never be orphaned. CRITICAL: if BOTH exist, use the
// LARGER one — a fresh/empty file (a stray runyard.sqlite, or a leftover legacy)
// must never shadow the populated database. This exact bug silently ran a live
// hub on an empty 4 KB runyard.sqlite for days while its 387 MB real DB sat
// orphaned beside it. Size comparison deterministically picks the real data.
const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 43117}`;
// Treat an explicit production flag or an https base URL as a production deployment.
const isProduction = process.env.NODE_ENV === "production" || baseUrl.startsWith("https://");

export const env = {
  root,
  dataDir,
  dbPath: firstEnv("RUNYARD_HUB_DB", "SMITHERS_HUB_DB") || defaultDbPath(dataDir),
  artifactDir: firstEnv("RUNYARD_HUB_ARTIFACT_DIR", "SMITHERS_HUB_ARTIFACT_DIR") || path.join(dataDir, "artifacts"),
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 43117),
  baseUrl,
  isProduction,
  // Public product name. Every user-visible surface defaults to "Runyard"; the
  // legacy SMITHERS_HUB_INSTANCE_NAME is still honored for back-compat.
  instanceName: firstEnv("RUNYARD_HUB_INSTANCE_NAME", "SMITHERS_HUB_INSTANCE_NAME") || "Runyard",
  environment: deriveEnvironmentLabel({ env: process.env, baseUrl, isProduction }),
  hostname: deriveHostnameLabel({ env: process.env, baseUrl }),
  sessionSecret: resolveSessionSecret({ env: process.env, dataDir, isProduction }),
  bootstrapToken: firstEnv("RUNYARD_HUB_BOOTSTRAP_TOKEN", "SMITHERS_HUB_BOOTSTRAP_TOKEN") || "",
  releaseDocsUpdateEndpointSecret:
    firstEnv(
      "RUNYARD_HUB_RELEASE_DOCS_UPDATE_SECRET",
      "RUNYARD_RELEASE_DOCS_UPDATE_ENDPOINT_SECRET"
    ) || "",
  runyardMobileFeedbackEndpointSecret:
    firstEnv(
      "RUNYARD_HUB_MOBILE_FEEDBACK_SECRET",
      "RUNYARD_MOBILE_FEEDBACK_ENDPOINT_SECRET",
      "SMITHERS_HUB_RUNYARD_MOBILE_FEEDBACK_SECRET"
    ) || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || process.env.SMITHERS_TELEGRAM_BOT_TOKEN || "",
  telegramApprovalChatId:
    process.env.TELEGRAM_APPROVAL_CHAT_ID ||
    process.env.SMITHERS_TELEGRAM_APPROVAL_CHAT_ID ||
    process.env.TELEGRAM_APPROVAL_USER_ID ||
    process.env.SMITHERS_TELEGRAM_APPROVAL_USER_ID ||
    "",
  telegramApprovalUserIds:
    process.env.TELEGRAM_APPROVAL_USER_IDS ||
    process.env.SMITHERS_TELEGRAM_APPROVAL_USER_IDS ||
    process.env.TELEGRAM_APPROVAL_CHAT_ID ||
    process.env.SMITHERS_TELEGRAM_APPROVAL_CHAT_ID ||
    process.env.TELEGRAM_APPROVAL_USER_ID ||
    process.env.SMITHERS_TELEGRAM_APPROVAL_USER_ID ||
    "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.SMITHERS_TELEGRAM_CHAT_ID || "",
  telegramThreadId: process.env.TELEGRAM_THREAD_ID || process.env.SMITHERS_TELEGRAM_THREAD_ID || "",
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
  // Runners are considered offline if no heartbeat within this window.
  runnerOfflineMs: Number(process.env.SMITHERS_RUNNER_OFFLINE_MS || 30_000),
  // Runner rows whose last heartbeat is older than this are deleted by the
  // reaper (long-dead ghosts from restarts before stable-identity registration).
  // Runners with in-flight work (active_runs>0 / current_run_id) are never
  // pruned. Default 24h. 0 disables pruning.
  runnerPruneMs: Number(process.env.SMITHERS_RUNNER_PRUNE_MS || 24 * 60 * 60_000),
  // Running/assigned runs are considered stalled if they emit no event within this window. 0 disables.
  runStallMs: Number(process.env.SMITHERS_RUN_STALL_MS || 15 * 60_000),
  // Express trust-proxy setting. Default 'loopback' so X-Forwarded-For can't be spoofed by clients.
  // Set to a proxy IP/subnet, a hop count, or 'true' only behind a trusted reverse proxy.
  trustProxy: parseTrustProxy(process.env.SMITHERS_TRUST_PROXY),
  // Optional max-runtime backstop for the reaper. Heartbeat/stall liveness is primary; 0 disables.
  runDeadlineMs: Number(process.env.SMITHERS_RUN_DEADLINE_MS || 0),
  // Best-effort terminal run obstruction analysis. If no provider/API key is
  // configured, the artifact pass is skipped; deterministic retrospectives
  // still run normally.
  obstructionAnalysisEnabled: parseBool(process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED, true),
  obstructionAnalysisApiKey: process.env.SMITHERS_OBSTRUCTION_ANALYSIS_API_KEY || process.env.OPENAI_API_KEY || "",
  obstructionAnalysisUrl: process.env.SMITHERS_OBSTRUCTION_ANALYSIS_URL || "",
  obstructionAnalysisModel: process.env.SMITHERS_OBSTRUCTION_ANALYSIS_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  obstructionAnalysisTimeoutMs: Number(process.env.SMITHERS_OBSTRUCTION_ANALYSIS_TIMEOUT_MS || 20_000),
  obstructionAnalysisMaxPromptChars: Number(process.env.SMITHERS_OBSTRUCTION_ANALYSIS_MAX_PROMPT_CHARS || 12_000),
  // Unified per-run timeline endpoint and `runyard tail` CLI. Enabled by
  // default because it is a read-only view over existing run/event/artifact
  // state; operators can still disable it with RUNYARD_RUN_TIMELINE=0.
  runTimelineEnabled: parseBool(process.env.RUNYARD_RUN_TIMELINE, true),
  // --- Self-host update check + apply ---------------------------------------
  // Passive update CHECK: poll the public GitHub Releases API (outbound-only,
  // read-only) and surface "update available" in the admin UI. Default ON — it
  // is low risk (no phone-home, no remote control) — but fully toggleable off.
  updateCheckEnabled: parseBool(process.env.UPDATE_CHECK_ENABLED, true),
  // How often the background poller refreshes the latest-release reading. Also
  // the cache TTL, so the GitHub API is never hammered. Default 1h.
  updateCheckIntervalMs: Number(process.env.UPDATE_CHECK_INTERVAL_MS || 60 * 60_000),
  // owner/repo to check releases for. Defaults to the canonical RunYard repo.
  githubRepo: process.env.GITHUB_REPO || "yolo-maxi/runyard",
  // Optional operator-owned webhook (their Slack/Discord/etc.) that receives the
  // update OUTCOME. Generic outbound POST only — never a maintainer endpoint.
  updateNotifyWebhook: process.env.UPDATE_NOTIFY_WEBHOOK || "",
  // Allow triggering `runyard update` over HTTP (admin-only endpoint / UI button).
  // OFF by default: a privileged self-update reachable over the network is
  // sensitive on a box we never see. When off, the operator runs `runyard update`
  // (or scripts/runyard-update.sh) on the host. The endpoint stays admin-gated
  // even when enabled.
  updateApplyEnabled: parseBool(process.env.UPDATE_APPLY_ENABLED, false),
  // Bounded grace window the updater waits for runners to drain in-flight work
  // before swapping code. If work doesn't finish in time the update ABORTS (it
  // never kills in-flight runs). Default 45 minutes.
  drainGraceMs: Number(process.env.RUNYARD_DRAIN_GRACE_MS || 45 * 60_000),
  // Shared drain flag path; the runner checks it before claiming new work.
  drainFlagPath: path.join(dataDir, ".drain"),
  version: pkgVersion
};
