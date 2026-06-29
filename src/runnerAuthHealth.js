// Runner-side CLI auth health.
//
// The runner reports, on each heartbeat, whether the host's Codex and Claude
// subscription logins are still valid — derived from the on-disk auth files the
// CLIs maintain. This is what lets the Hub UI show a red "Codex expired" strip
// instead of discovering it only when a run silently fails (the exact failure
// that made support chat fall back from Codex to Claude).
//
// HARD RULE: this module returns booleans + expiry + account id ONLY. It never
// returns, logs, or forwards any token material (id/access/refresh tokens).
//
// File shapes (observed on the Hetzner host):
//   ~/.codex/auth.json:
//     { auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token,
//       refresh_token, account_id }, last_refresh }
//     -> expiry from the id_token JWT `exp` claim; account id from
//        tokens.account_id; last_refresh as a freshness hint.
//   ~/.claude/.credentials.json:
//     { claudeAiOauth: { accessToken, refreshToken, expiresAt(ms), ... } }
//     -> expiry from claudeAiOauth.expiresAt (epoch ms).
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClaudeOauthTokenHealth, readClaudeOauthToken } from "./claudeOauthToken.js";

// Decode the `exp` (seconds since epoch) from a JWT WITHOUT retaining the token.
// Returns a number (ms) or null. Never throws, never logs the token.
function jwtExpMs(jwt) {
  try {
    const parts = String(jwt || "").split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1000;
    return null;
  } catch {
    return null;
  }
}

function toIso(ms) {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

// How long after the last refresh we still trust a refresh_token to mint a new
// short token. The codex/claude refresh tokens are long-lived (weeks); this is a
// conservative staleness ceiling so a genuinely-abandoned login eventually badges
// expired, without flapping to "expired" the moment the ~1h access token lapses.
const REFRESH_TTL_MS = Number(process.env.RUNYARD_AUTH_REFRESH_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;

function parseTimestamp(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

// Pure parser for ~/.codex/auth.json content. `nowMs` is injectable for tests.
//
// The id_token is a short-lived (~1h) access JWT; the refresh_token is the
// long-lived credential the codex CLI silently uses to mint a fresh id_token on
// each run. So health MUST consider both — judging "expired" solely from the 1h
// id_token exp flips the badge red ~1h after every login even though the login is
// fine. `ok` = id_token still valid OR a (recent) refresh_token is present.
export function parseCodexAuth(auth, nowMs = Date.now()) {
  if (!auth || typeof auth !== "object") return { ok: false, error: "no codex auth" };
  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : null;
  const hasRefresh = Boolean(tokens && tokens.refresh_token);
  if (!tokens || (!tokens.id_token && !hasRefresh)) return { ok: false, error: "no codex session" };

  const expMs = tokens.id_token ? jwtExpMs(tokens.id_token) : null;
  const lastRefreshMs = parseTimestamp(auth.last_refresh);
  const result = {};
  if (tokens.account_id) result.accountId = String(tokens.account_id);
  if (expMs != null) result.expiresAt = toIso(expMs);
  if (lastRefreshMs != null) result.lastRefresh = toIso(lastRefreshMs);

  // id_token valid: decodable + future, OR present-but-undecodable (can't prove
  // expiry → stay lenient as before). refreshable: a refresh_token whose last
  // refresh is within the staleness ceiling (unknown last_refresh ⇒ trust it).
  const idTokenOk = tokens.id_token ? (expMs == null ? true : expMs > nowMs) : false;
  const refreshable = hasRefresh && (lastRefreshMs == null || nowMs - lastRefreshMs < REFRESH_TTL_MS);

  result.fresh = expMs != null && expMs > nowMs;
  result.refreshable = refreshable;
  result.ok = idTokenOk || refreshable;
  if (!result.ok) {
    result.error = hasRefresh ? "codex refresh token stale — re-auth recommended" : "codex session expired";
  } else if (!result.fresh && refreshable) {
    result.note = "id_token expired; codex refreshes it on next run";
  } else if (expMs == null && idTokenOk) {
    result.error = "expiry not derivable from id_token";
  }
  return result;
}

// Pure parser for ~/.claude/.credentials.json content. `nowMs` injectable.
// Same principle as codex: `accessToken`/`expiresAt` is short-lived; the
// `refreshToken` keeps the login alive (Claude Code refreshes on use). Don't
// badge "expired" just because the short access token lapsed.
export function parseClaudeCredentials(creds, nowMs = Date.now()) {
  if (!creds || typeof creds !== "object") return { ok: false, error: "no claude credentials" };
  const oauth = creds.claudeAiOauth && typeof creds.claudeAiOauth === "object" ? creds.claudeAiOauth : null;
  const hasRefresh = Boolean(oauth && oauth.refreshToken);
  if (!oauth || (oauth.expiresAt == null && !hasRefresh)) return { ok: false, error: "no claude session" };

  const expMs = oauth.expiresAt != null ? Number(oauth.expiresAt) : null;
  const result = {};
  if (expMs != null && Number.isFinite(expMs)) result.expiresAt = toIso(expMs);

  const accessOk = expMs != null && Number.isFinite(expMs) && expMs > nowMs;
  result.fresh = accessOk;
  result.refreshable = hasRefresh;
  result.ok = accessOk || hasRefresh;
  if (!result.ok) {
    result.error = expMs != null && !Number.isFinite(expMs) ? "invalid claude expiry" : "claude session expired";
  } else if (!accessOk && hasRefresh) {
    result.note = "access token expired; claude refreshes it on next run";
  }
  return result;
}

function bestClaudeHealth(credentialsHealth, tokenHealth) {
  if (credentialsHealth?.ok) return credentialsHealth;
  if (tokenHealth?.ok) return tokenHealth;
  return credentialsHealth?.error === "credentials.json not found" ? tokenHealth || credentialsHealth : credentialsHealth;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Read + parse both providers' on-disk auth into the heartbeat shape. Paths are
// injectable for tests; defaults follow the CLIs' real locations under $HOME.
export function collectAuthHealth({
  now = Date.now(),
  home = process.env.HOME || os.homedir(),
  codexPath,
  claudePath,
  claudeOauthToken,
  claudeOauthTokenPath
} = {}) {
  const codexFile = codexPath || path.join(home, ".codex", "auth.json");
  const claudeFile = claudePath || path.join(home, ".claude", ".credentials.json");
  const codexJson = readJsonSafe(codexFile);
  const claudeJson = readJsonSafe(claudeFile);
  const token = claudeOauthToken ?? readClaudeOauthToken({ home, filePath: claudeOauthTokenPath });
  const credentialsHealth = claudeJson ? parseClaudeCredentials(claudeJson, now) : { ok: false, error: "credentials.json not found" };
  const tokenHealth = token ? parseClaudeOauthTokenHealth(token, now) : { ok: false, error: "CLAUDE_CODE_OAUTH_TOKEN not found" };
  return {
    codex: codexJson ? parseCodexAuth(codexJson, now) : { ok: false, error: "auth.json not found" },
    claude: bestClaudeHealth(credentialsHealth, tokenHealth),
    checkedAt: toIso(now)
  };
}
