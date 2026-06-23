import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

const root = process.env.SMITHERS_HUB_ROOT || process.cwd();
const dataDir = process.env.SMITHERS_HUB_DATA_DIR || path.join(root, "data");

mkdirSync(dataDir, { recursive: true });
mkdirSync(path.join(dataDir, "artifacts", "runs"), { recursive: true });

const DEV_SECRET = "dev-smithers-hub-session-secret";
const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 43117}`;
// Treat an explicit production flag or an https base URL as a production deployment.
const isProduction = process.env.NODE_ENV === "production" || baseUrl.startsWith("https://");

// Operator-visible environment label sourced from config, with a sensible
// derivation from the base URL when nothing is set. Surfaced in the header so
// operators bouncing between hubs (.248 vs Hetzner) know which one they're on.
function deriveEnvironmentLabel() {
  const explicit = process.env.SMITHERS_HUB_ENVIRONMENT || process.env.SMITHERS_HUB_ENV || "";
  if (explicit) return explicit.toLowerCase();
  if (!isProduction) return "local";
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (/(^|[.-])(stage|staging|preprod)([.-]|$)/.test(host)) return "staging";
    if (/(^|[.-])(dev|test)([.-]|$)/.test(host)) return "dev";
    return "prod";
  } catch {
    return "prod";
  }
}

function deriveHostnameLabel() {
  const explicit = process.env.SMITHERS_HUB_HOSTNAME || "";
  if (explicit) return explicit;
  try {
    const host = new URL(baseUrl).hostname;
    if (host && host !== "127.0.0.1" && host !== "localhost") return host;
  } catch {
    /* fall through */
  }
  try {
    return os.hostname() || "local";
  } catch {
    return "local";
  }
}

function resolveSessionSecret() {
  const provided = process.env.SMITHERS_HUB_SESSION_SECRET;
  if (provided && provided !== DEV_SECRET) return provided;
  if (isProduction) {
    if (provided === DEV_SECRET) {
      throw new Error(
        "Refusing to start: SMITHERS_HUB_SESSION_SECRET is set to the insecure development default in a production deployment. Set a long random secret."
      );
    }
    // No secret provided in production: persist a generated one so sessions survive restarts.
  }
  const secretFile = path.join(dataDir, "session-secret.txt");
  if (existsSync(secretFile)) {
    const persisted = readFileSync(secretFile, "utf8").trim();
    if (persisted) return persisted;
  }
  if (provided === DEV_SECRET || !isProduction) {
    // Local development with no real secret: fall back to a generated-and-persisted one.
  }
  const generated = randomBytes(32).toString("base64url");
  writeFileSync(secretFile, `${generated}\n`, { mode: 0o600 });
  try {
    chmodSync(secretFile, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return generated;
}

function parseRoots(value) {
  return String(value || "")
    .split(/[:,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function parseBool(value, fallback = true) {
  if (value == null || value === "") return fallback;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

export const env = {
  root,
  dataDir,
  dbPath: process.env.SMITHERS_HUB_DB || path.join(dataDir, "smithers-hub.sqlite"),
  artifactDir: process.env.SMITHERS_HUB_ARTIFACT_DIR || path.join(dataDir, "artifacts"),
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 43117),
  baseUrl,
  isProduction,
  // Public product name. The codebase keeps the smithers-hub prefix for back-
  // compat, but every user-visible surface defaults to "Runyard".
  instanceName: process.env.SMITHERS_HUB_INSTANCE_NAME || "Runyard",
  environment: deriveEnvironmentLabel(),
  hostname: deriveHostnameLabel(),
  sessionSecret: resolveSessionSecret(),
  bootstrapToken: process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN || "",
  runyardMobileFeedbackEndpointSecret:
    process.env.SMITHERS_HUB_RUNYARD_MOBILE_FEEDBACK_SECRET ||
    process.env.RUNYARD_MOBILE_FEEDBACK_ENDPOINT_SECRET ||
    "",
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
  // Running/assigned runs are considered stalled if they emit no event within this window. 0 disables.
  runStallMs: Number(process.env.SMITHERS_RUN_STALL_MS || 15 * 60_000),
  // Optional allow-list of filesystem roots the runner may operate in. Empty = unrestricted (with a warning).
  runnerAllowedRoots: parseRoots(process.env.SMITHERS_RUNNER_ALLOWED_ROOTS),
  // Express trust-proxy setting. Default 'loopback' so X-Forwarded-For can't be spoofed by clients.
  // Set to a proxy IP/subnet, a hop count, or 'true' only behind a trusted reverse proxy.
  trustProxy: (() => {
    const raw = process.env.SMITHERS_TRUST_PROXY;
    if (raw == null || raw === "") return "loopback";
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw;
  })(),
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
  version: "0.1.0"
};
