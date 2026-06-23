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

// Pure parser for ~/.codex/auth.json content. `nowMs` is injectable for tests.
export function parseCodexAuth(auth, nowMs = Date.now()) {
  if (!auth || typeof auth !== "object") return { ok: false, error: "no codex auth" };
  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : null;
  if (!tokens || !tokens.id_token) return { ok: false, error: "no codex session" };
  const expMs = jwtExpMs(tokens.id_token);
  const result = {};
  if (tokens.account_id) result.accountId = String(tokens.account_id);
  if (expMs != null) {
    result.expiresAt = toIso(expMs);
    result.ok = expMs > nowMs;
  } else {
    // No decodable expiry — treat presence of a session as ok but surface that
    // we could not verify the expiry so the UI can hint at it.
    result.ok = true;
    result.error = "expiry not derivable from id_token";
  }
  return result;
}

// Pure parser for ~/.claude/.credentials.json content. `nowMs` injectable.
export function parseClaudeCredentials(creds, nowMs = Date.now()) {
  if (!creds || typeof creds !== "object") return { ok: false, error: "no claude credentials" };
  const oauth = creds.claudeAiOauth && typeof creds.claudeAiOauth === "object" ? creds.claudeAiOauth : null;
  if (!oauth || oauth.expiresAt == null) return { ok: false, error: "no claude session" };
  const expMs = Number(oauth.expiresAt);
  if (!Number.isFinite(expMs)) return { ok: false, error: "invalid claude expiry" };
  return { ok: expMs > nowMs, expiresAt: toIso(expMs) };
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
  claudePath
} = {}) {
  const codexFile = codexPath || path.join(home, ".codex", "auth.json");
  const claudeFile = claudePath || path.join(home, ".claude", ".credentials.json");
  const codexJson = readJsonSafe(codexFile);
  const claudeJson = readJsonSafe(claudeFile);
  return {
    codex: codexJson ? parseCodexAuth(codexJson, now) : { ok: false, error: "auth.json not found" },
    claude: claudeJson ? parseClaudeCredentials(claudeJson, now) : { ok: false, error: "credentials.json not found" },
    checkedAt: toIso(now)
  };
}
