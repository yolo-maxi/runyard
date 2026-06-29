import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const stripAnsi = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "");

export function claudeOauthTokenPath(home = process.env.HOME || os.homedir()) {
  return process.env.RUNYARD_CLAUDE_OAUTH_TOKEN_FILE || path.join(home, ".claude", "oauth-token");
}

function unquote(value) {
  let v = String(value || "").trim();
  if (v.startsWith("export ")) v = v.slice("export ".length).trim();
  if (v.startsWith("CLAUDE_CODE_OAUTH_TOKEN=")) v = v.slice("CLAUDE_CODE_OAUTH_TOKEN=".length).trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  return v.trim();
}

export function extractClaudeOauthToken(text) {
  const clean = stripAnsi(text);
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(export\s+)?CLAUDE_CODE_OAUTH_TOKEN=/.test(trimmed)) {
      const token = unquote(trimmed);
      if (token) return token;
    }
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const candidate = trimmed.slice(jsonStart, jsonEnd + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && (parsed.accessToken || parsed.refreshToken)) return candidate;
      } catch {
        /* keep scanning */
      }
    }
    const oat = trimmed.match(/\bsk-ant-oat[0-9A-Za-z._-]+\b/);
    if (oat) return oat[0];
  }
  return "";
}

export function writeClaudeOauthToken(token, { home, filePath } = {}) {
  const value = String(token || "").trim();
  if (!value) return "";
  const outPath = filePath || claudeOauthTokenPath(home);
  mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, value, { mode: 0o600 });
  return outPath;
}

export function readClaudeOauthToken({ home, filePath } = {}) {
  const inPath = filePath || claudeOauthTokenPath(home);
  try {
    return readFileSync(inPath, "utf8").trim();
  } catch {
    return "";
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

function parseExpiry(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

export function parseClaudeOauthTokenHealth(token, nowMs = Date.now()) {
  if (!token) return { ok: false, error: "CLAUDE_CODE_OAUTH_TOKEN not found" };
  const result = { ok: true, source: "CLAUDE_CODE_OAUTH_TOKEN" };
  try {
    const parsed = JSON.parse(String(token));
    const expMs = parseExpiry(parsed.expiresAt ?? parsed.claudeAiOauth?.expiresAt);
    if (expMs != null) {
      result.expiresAt = toIso(expMs);
      result.fresh = expMs > nowMs;
      result.ok = expMs > nowMs;
      if (!result.ok) result.error = "CLAUDE_CODE_OAUTH_TOKEN expired";
    } else {
      result.note = "OAuth token present; expiry not derivable";
    }
    return result;
  } catch {
    result.note = "OAuth token present; expiry not derivable";
    return result;
  }
}
