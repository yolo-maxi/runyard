import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { parseCodexDeviceAuth, parseClaudeSetupToken, runReauth, reauthEnabled } = await import("../src/reauthCli.js");
const { claudeOauthTokenPath, extractClaudeOauthToken } = await import("../src/claudeOauthToken.js");

// A realistic codex `login --device-auth` stdout sample.
const CODEX_STDOUT = [
  "Starting Codex device authorization…",
  "To sign in, open https://auth.openai.com/activate in your browser",
  "and enter the code: WDJB-MJHT",
  "This code expires in 900 seconds.",
  "Waiting for authorization…"
].join("\n");

const CLAUDE_STDOUT = [
  "Open this URL to authorize Claude Code:",
  "  https://claude.ai/oauth/authorize?scope=token",
  "Enter the code shown after approving: ABCD-1234"
].join("\n");

const CLAUDE_TOKEN = JSON.stringify({
  accessToken: "CLAUDE-ACCESS-SHOULD-NOT-LEAK",
  refreshToken: "CLAUDE-REFRESH-SHOULD-NOT-LEAK",
  expiresAt: "2027-01-01T00:00:00.000Z"
});

describe("reauth output parsers", () => {
  it("extracts the verification URL, user code, and TTL from codex device-auth stdout", () => {
    const parsed = parseCodexDeviceAuth(CODEX_STDOUT);
    assert.equal(parsed.verificationUrl, "https://auth.openai.com/activate");
    assert.equal(parsed.userCode, "WDJB-MJHT");
    assert.equal(parsed.expiresInSec, 900);
  });

  it("extracts URL + code from claude setup-token stdout", () => {
    const parsed = parseClaudeSetupToken(CLAUDE_STDOUT);
    assert.equal(parsed.verificationUrl, "https://claude.ai/oauth/authorize?scope=token");
    assert.equal(parsed.userCode, "ABCD-1234");
  });

  it("extracts Claude OAuth token output without requiring a credentials file", () => {
    assert.equal(extractClaudeOauthToken(`CLAUDE_CODE_OAUTH_TOKEN='${CLAUDE_TOKEN}'`), CLAUDE_TOKEN);
    assert.equal(extractClaudeOauthToken(`export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc_DEF.123`), "sk-ant-oat01-abc_DEF.123");
  });

  it("tolerates partial/streamed chunks without crashing", () => {
    assert.deepEqual(parseCodexDeviceAuth(""), {});
    assert.deepEqual(parseCodexDeviceAuth("nothing useful here"), {});
  });
});

describe("reauthEnabled gating", () => {
  it("is off by default, on for truthy values, off for falsy words", () => {
    const prev = process.env.REAUTH_ENABLED;
    try {
      delete process.env.REAUTH_ENABLED;
      assert.equal(reauthEnabled(), false);
      for (const on of ["1", "true", "yes"]) {
        process.env.REAUTH_ENABLED = on;
        assert.equal(reauthEnabled(), true, `expected REAUTH_ENABLED=${on} to enable`);
      }
      for (const off of ["0", "false", "off", "no", ""]) {
        process.env.REAUTH_ENABLED = off;
        assert.equal(reauthEnabled(), false, `expected REAUTH_ENABLED=${JSON.stringify(off)} to disable`);
      }
    } finally {
      if (prev === undefined) delete process.env.REAUTH_ENABLED;
      else process.env.REAUTH_ENABLED = prev;
    }
  });

  it("ships dstack runner settings needed for persistent CLI reauth", () => {
    const compose = readFileSync(path.join(process.cwd(), "deploy", "dstack", "docker-compose.dstack.yml"), "utf8");
    const docs = readFileSync(path.join(process.cwd(), "deploy", "dstack", "README.md"), "utf8");
    assert.match(compose, /REAUTH_ENABLED:\s*"1"/);
    assert.match(compose, /SMITHERS_RUNNER_TAGS:[^\n]*reauth/);
    assert.match(compose, /HOME:\s*"\/runner-home"/);
    assert.match(compose, /runner-home:\/runner-home/);
    assert.match(docs, /\/runner-home\/\.codex\/auth\.json/);
    assert.match(docs, /\/runner-home\/\.claude\/\.credentials\.json/);
    assert.match(docs, /\/runner-home\/\.claude\/oauth-token/);
  });
});

// Build a fake child process for the injectable spawn. Mirrors the subset of
// the child_process API runReauth uses: stdout/stderr emitters, on(exit|error),
// kill().
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function jwt(expSeconds, extra = {}) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc({ exp: expSeconds, ...extra })}.sig`;
}

describe("runReauth (mocked child process — never a live login)", () => {
  it("streams verification details then completes ok with account id + expiry, no token material", async () => {
    const NOW = 1_800_000_000_000;
    const home = mkdtempSync(path.join(os.tmpdir(), "reauth-home-"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { id_token: jwt(NOW / 1000 + 3600), access_token: "ACCESS-LEAK", account_id: "acct_ok" } })
    );

    const verifications = [];
    const child = fakeChild();
    const spawnFn = () => {
      // Emit stdout + exit on the next tick so the listeners are attached.
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(CODEX_STDOUT));
        setImmediate(() => child.emit("exit", 0));
      });
      return child;
    };

    const result = await runReauth(
      { provider: "codex" },
      { spawnFn, home, now: () => NOW, onVerification: (info) => verifications.push(info) }
    );

    assert.equal(result.status, "ok");
    assert.equal(result.provider, "codex");
    assert.equal(result.accountId, "acct_ok");
    assert.ok(result.expiresAt);
    assert.equal(verifications.length, 1);
    assert.equal(verifications[0].verificationUrl, "https://auth.openai.com/activate");
    assert.equal(verifications[0].userCode, "WDJB-MJHT");
    // Never any token material in the verification payload or result.
    const serialized = JSON.stringify({ result, verifications });
    assert.ok(!serialized.includes("ACCESS-LEAK"));
    assert.ok(!serialized.includes("id_token"));
  });

  it("persists Claude setup-token output as a runner-local oauth token and does not emit it", async () => {
    const NOW = Date.parse("2026-01-01T00:00:00.000Z");
    const home = mkdtempSync(path.join(os.tmpdir(), "reauth-claude-home-"));
    const child = fakeChild();
    const spawnFn = () => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`${CLAUDE_STDOUT}\nCLAUDE_CODE_OAUTH_TOKEN='${CLAUDE_TOKEN}'\n`));
        setImmediate(() => child.emit("exit", 0));
      });
      return child;
    };

    const verifications = [];
    const result = await runReauth(
      { provider: "claude" },
      { spawnFn, home, now: () => NOW, onVerification: (info) => verifications.push(info) }
    );

    const tokenPath = claudeOauthTokenPath(home);
    assert.equal(result.status, "ok");
    assert.equal(result.provider, "claude");
    assert.ok(result.expiresAt);
    assert.equal(verifications.length, 1);
    assert.equal(existsSync(tokenPath), true);
    assert.equal(readFileSync(tokenPath, "utf8"), CLAUDE_TOKEN);
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    const serialized = JSON.stringify({ result, verifications });
    assert.ok(!serialized.includes("CLAUDE-ACCESS-SHOULD-NOT-LEAK"));
    assert.ok(!serialized.includes("CLAUDE-REFRESH-SHOULD-NOT-LEAK"));
  });

  it("stores a pasted Claude OAuth token from encrypted one-run secret env without spawning setup-token", async () => {
    const NOW = Date.parse("2026-01-01T00:00:00.000Z");
    const home = mkdtempSync(path.join(os.tmpdir(), "reauth-claude-paste-home-"));
    let spawned = false;
    const result = await runReauth(
      { provider: "claude", oauthTokenSecretName: "RUNYARD_CLAUDE_OAUTH_TOKEN_RUNNER_X" },
      {
        home,
        now: () => NOW,
        secretEnv: { RUNYARD_CLAUDE_OAUTH_TOKEN_RUNNER_X: CLAUDE_TOKEN },
        spawnFn: () => {
          spawned = true;
          return fakeChild();
        }
      }
    );

    const tokenPath = claudeOauthTokenPath(home);
    assert.equal(result.status, "ok");
    assert.equal(result.provider, "claude");
    assert.equal(spawned, false);
    assert.equal(readFileSync(tokenPath, "utf8"), CLAUDE_TOKEN);
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(result).includes("CLAUDE-ACCESS-SHOULD-NOT-LEAK"));
  });

  it("kills the process and fails with a clear message on timeout", async () => {
    const child = fakeChild();
    const spawnFn = () => {
      // Emit the verification but never exit -> timeout path.
      setImmediate(() => child.stdout.emit("data", Buffer.from(CODEX_STDOUT)));
      return child;
    };
    const result = await runReauth({ provider: "codex" }, { spawnFn, timeoutMs: 40 });
    assert.equal(result.status, "timeout");
    assert.match(result.error, /timed out/);
    assert.equal(child.killed, true);
  });

  it("fails on a non-zero exit and surfaces stderr", async () => {
    const child = fakeChild();
    const spawnFn = () => {
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("error: not logged in to the right account"));
        setImmediate(() => child.emit("exit", 1));
      });
      return child;
    };
    const result = await runReauth({ provider: "codex" }, { spawnFn });
    assert.equal(result.status, "failed");
    assert.match(result.error, /exited 1/);
  });

  it("rejects an unknown provider without spawning anything", async () => {
    let spawned = false;
    const result = await runReauth({ provider: "bogus" }, { spawnFn: () => { spawned = true; return fakeChild(); } });
    assert.equal(result.status, "invalid");
    assert.equal(spawned, false);
  });
});
