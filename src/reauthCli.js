// Runner-side CLI re-auth.
//
// Drives the real subscription login flow on the runner host so an operator can
// re-auth Codex/Claude from the Hub UI without SSH'ing into Hetzner. Mirrors the
// supportWarm.js special-path pattern: a gated branch in runner.js
// calls runReauth() instead of `smithers up`.
//
//   codex:  `codex login --device-auth` emits a verification URL + user code,
//           then polls until authorized and writes ~/.codex/auth.json.
//   claude: `claude setup-token` runs the interactive OAuth and prints a
//           long-lived CLAUDE_CODE_OAUTH_TOKEN. It does not save the token, so
//           RunYard persists it in a runner-local 0600 file for future jobs.
//           For remote/headless runners the preferred UX is to generate that
//           token locally, paste it into the Hub's write-only field, and send it
//           to this runner as an encrypted one-run secret.
//
// We stream-parse stdout, surface ONLY the verification URL + user code (+ TTL)
// back to the Hub as run output so the UI can render "Open <url>, enter <code>",
// and complete the run with status + account id + expiry once the file lands.
//
// HARD RULE: never emit token material. onVerification receives parsed URL/code
// only; the final result carries status/provider/accountId/expiresAt only — the
// access/refresh/id tokens are never read into the result or any log.
//
// Gated by REAUTH_ENABLED=1 (set only on runner hosts allowed to re-auth) so the
// general pool can never be coerced into running a login.
import { spawn as nodeSpawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { allowlistedBaseEnv } from "./childEnv.js";
import { extractClaudeOauthToken, writeClaudeOauthToken } from "./claudeOauthToken.js";
import { parseBool } from "./configParsing.js";
import { collectAuthHealth } from "./runnerAuthHealth.js";

const CODEX_BIN = process.env.REAUTH_CODEX_BIN || "codex";
const CLAUDE_BIN = process.env.REAUTH_CLAUDE_BIN || "claude";
const DEFAULT_TIMEOUT_MS = Number(process.env.REAUTH_TIMEOUT_MS || 5 * 60_000);

export function reauthEnabled() {
  return parseBool(process.env.REAUTH_ENABLED, false);
}

// Strip ANSI so URL/code regexes match clean text.
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/i;
// A user/device code: groups of A-Z0-9 separated by - or spaces (e.g. ABCD-EFGH,
// WDJB-MJHT), 4+ chars. Kept tight so it doesn't swallow ordinary words.
const CODE_RE = /\b([A-Z0-9]{3,}(?:[-\s][A-Z0-9]{3,})+)\b/;
const EXPIRES_RE = /\bexpires?\s+in\s+(\d+)\s*(seconds?|secs?|minutes?|mins?)\b/i;

// Parse codex `login --device-auth` stdout. Returns whatever fields are present
// so a caller can detect "do we have both URL and code yet?".
export function parseCodexDeviceAuth(text) {
  const clean = stripAnsi(text || "");
  const out = {};
  const url = clean.match(URL_RE);
  if (url) out.verificationUrl = url[0].replace(/[.,]+$/, "");
  const code = clean.match(CODE_RE);
  if (code) out.userCode = code[1].replace(/\s+/g, "-");
  const exp = clean.match(EXPIRES_RE);
  if (exp) {
    const n = Number(exp[1]);
    out.expiresInSec = /min/i.test(exp[2]) ? n * 60 : n;
  }
  return out;
}

// Parse claude `setup-token` stdout — same surface (URL + code).
export function parseClaudeSetupToken(text) {
  const clean = stripAnsi(text || "");
  const out = {};
  const url = clean.match(URL_RE);
  if (url) out.verificationUrl = url[0].replace(/[.,]+$/, "");
  const code = clean.match(CODE_RE);
  if (code) out.userCode = code[1].replace(/\s+/g, "-");
  return out;
}

function commandFor(provider) {
  if (provider === "codex") return { bin: CODEX_BIN, args: ["login", "--device-auth"], parse: parseCodexDeviceAuth };
  if (provider === "claude") return { bin: CLAUDE_BIN, args: ["setup-token"], parse: parseClaudeSetupToken };
  return null;
}

function pastedClaudeOauthToken(input = {}, deps = {}) {
  const secretName = String(input.oauthTokenSecretName || "").trim();
  if (secretName && deps.secretEnv && typeof deps.secretEnv === "object" && deps.secretEnv[secretName]) {
    return String(deps.secretEnv[secretName]);
  }
  if (deps.claudeOauthToken) return String(deps.claudeOauthToken);
  return "";
}

// Derive post-login health (account id + expiry, no tokens) from the auth files
// and the runner-local Claude OAuth token file.
function deriveHealth(provider, deps) {
  const health = collectAuthHealth({ now: deps.now ? deps.now() : Date.now(), home: deps.home });
  const p = provider === "codex" ? health.codex : health.claude;
  const result = { provider };
  if (p?.accountId) result.accountId = p.accountId;
  if (p?.expiresAt) result.expiresAt = p.expiresAt;
  return result;
}

// Run the re-auth flow. Returns one of:
//   { status: "ok", provider, accountId?, expiresAt? }
//   { status: "timeout"|"failed"|"invalid", provider?, error }
//
// Injectable deps (for tests — NEVER run a live login in tests):
//   spawnFn(bin, args, opts) -> child with stdout/stderr streams + on('exit')/kill
//   onVerification({ provider, verificationUrl, userCode, expiresInSec? })
//   timeoutMs, now(), home, baseEnv
export function runReauth(input = {}, deps = {}) {
  const provider = String(input.provider || "").toLowerCase();
  const cmd = commandFor(provider);
  if (!cmd) return Promise.resolve({ status: "invalid", error: `unknown provider '${input.provider}'` });

  const spawnFn = deps.spawnFn || nodeSpawn;
  const onVerification = typeof deps.onVerification === "function" ? deps.onVerification : () => {};
  const timeoutMs = Number(deps.timeoutMs || DEFAULT_TIMEOUT_MS);
  const home = deps.home || process.env.HOME || os.homedir();

  const pastedToken = provider === "claude" ? pastedClaudeOauthToken(input, deps) : "";
  if (pastedToken) {
    writeClaudeOauthToken(pastedToken, { home });
    return Promise.resolve({ status: "ok", ...deriveHealth(provider, { now: deps.now, home }) });
  }

  return new Promise((resolve) => {
    let settled = false;
    let postedVerification = false;
    let parsed = {};
    let outputTail = "";
    let stderrTail = "";
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      // The login child gets the OS/toolchain baseline only (childEnv.js) — the
      // reauth runner's hub tokens and secrets must never reach a CLI login
      // flow. HOME is pinned to the resolved `home` so the auth files the flow
      // writes land where deriveHealth (and future runs) read them.
      child = spawnFn(cmd.bin, cmd.args, {
        cwd: home,
        env: { ...allowlistedBaseEnv(deps.baseEnv || process.env), HOME: home },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      return finish({ status: "failed", provider, error: `failed to spawn ${cmd.bin}: ${error.message}` });
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      finish({ status: "timeout", provider, error: `re-auth timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    const onChunk = (buf) => {
      const text = String(buf || "");
      outputTail = (outputTail + text).slice(-12_000);
      const next = cmd.parse(text);
      parsed = { ...parsed, ...next };
      // Post the verification details the moment we have BOTH url and code.
      if (!postedVerification && parsed.verificationUrl && parsed.userCode) {
        postedVerification = true;
        const info = {
          provider,
          verificationUrl: parsed.verificationUrl,
          userCode: parsed.userCode
        };
        if (parsed.expiresInSec) info.expiresInSec = parsed.expiresInSec;
        try {
          onVerification(info);
        } catch {
          /* delivery is best-effort; keep polling */
        }
      }
    };

    child.stdout?.on("data", onChunk);
    // codex prints the device-auth prompt to stderr in some versions — parse both.
    child.stderr?.on("data", (buf) => {
      stderrTail = (stderrTail + String(buf || "")).slice(-800);
      onChunk(buf);
    });

    child.on("error", (error) => finish({ status: "failed", provider, error: `re-auth process error: ${error.message}` }));
    child.on("exit", (code) => {
      if (settled) return;
      if (code === 0) {
        if (provider === "claude") {
          const token = extractClaudeOauthToken(outputTail);
          if (token) writeClaudeOauthToken(token, { home });
        }
        finish({ status: "ok", ...deriveHealth(provider, { now: deps.now, home }) });
      } else {
        const tail = stripAnsi(stderrTail).trim().slice(-300);
        finish({ status: "failed", provider, error: `re-auth exited ${code}${tail ? `: ${tail}` : ""}` });
      }
    });
  });
}
