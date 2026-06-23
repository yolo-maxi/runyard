import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { parseCodexAuth, parseClaudeCredentials, collectAuthHealth } = await import("../src/runnerAuthHealth.js");

// Build a JWT with a given exp (seconds). Header/payload only — signature is a
// placeholder; the parser only base64url-decodes the payload for `exp`.
function jwt(expSeconds, extra = {}) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ exp: expSeconds, ...extra })}.sig`;
}

const NOW = 1_800_000_000_000; // fixed ms

describe("codex auth health parser", () => {
  it("reports ok with expiry + account id for a valid, unexpired session", () => {
    const auth = {
      auth_mode: "subscription",
      tokens: {
        id_token: jwt(NOW / 1000 + 3600),
        access_token: "ACCESS-SHOULD-NOT-LEAK",
        refresh_token: "REFRESH-SHOULD-NOT-LEAK",
        account_id: "acct_123"
      },
      last_refresh: new Date(NOW - 60_000).toISOString()
    };
    const health = parseCodexAuth(auth, NOW);
    assert.equal(health.ok, true);
    assert.equal(health.accountId, "acct_123");
    assert.ok(health.expiresAt);
    // No token material in the derived health.
    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes("ACCESS-SHOULD-NOT-LEAK"));
    assert.ok(!serialized.includes("REFRESH-SHOULD-NOT-LEAK"));
  });

  it("reports not-ok when the id_token is expired", () => {
    const auth = { tokens: { id_token: jwt(NOW / 1000 - 10), account_id: "acct_x" } };
    const health = parseCodexAuth(auth, NOW);
    assert.equal(health.ok, false);
  });

  it("reports not-ok when there is no session", () => {
    assert.equal(parseCodexAuth({}, NOW).ok, false);
    assert.equal(parseCodexAuth(null, NOW).ok, false);
  });
});

describe("claude credentials health parser", () => {
  it("reports ok with expiry for an unexpired subscription token", () => {
    const creds = {
      claudeAiOauth: {
        accessToken: "CLAUDE-ACCESS-SHOULD-NOT-LEAK",
        refreshToken: "CLAUDE-REFRESH-SHOULD-NOT-LEAK",
        expiresAt: NOW + 3600_000,
        subscriptionType: "max"
      }
    };
    const health = parseClaudeCredentials(creds, NOW);
    assert.equal(health.ok, true);
    assert.ok(health.expiresAt);
    assert.ok(!JSON.stringify(health).includes("SHOULD-NOT-LEAK"));
  });

  it("reports not-ok when expired or missing", () => {
    assert.equal(parseClaudeCredentials({ claudeAiOauth: { expiresAt: NOW - 1 } }, NOW).ok, false);
    assert.equal(parseClaudeCredentials({}, NOW).ok, false);
  });
});

describe("collectAuthHealth from disk", () => {
  it("reads both providers from injected paths and never leaks tokens", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auth-health-"));
    const codexPath = path.join(dir, "auth.json");
    const claudePath = path.join(dir, "creds.json");
    writeFileSync(
      codexPath,
      JSON.stringify({ tokens: { id_token: jwt(NOW / 1000 + 7200), access_token: "X-LEAK", account_id: "acct_disk" } })
    );
    writeFileSync(claudePath, JSON.stringify({ claudeAiOauth: { accessToken: "Y-LEAK", expiresAt: NOW + 7200_000 } }));
    const health = collectAuthHealth({ now: NOW, codexPath, claudePath });
    assert.equal(health.codex.ok, true);
    assert.equal(health.codex.accountId, "acct_disk");
    assert.equal(health.claude.ok, true);
    assert.ok(health.checkedAt);
    const serialized = JSON.stringify(health);
    assert.ok(!serialized.includes("LEAK"));
  });

  it("reports not-ok when files are absent", () => {
    const health = collectAuthHealth({ now: NOW, codexPath: "/nope/auth.json", claudePath: "/nope/creds.json" });
    assert.equal(health.codex.ok, false);
    assert.equal(health.claude.ok, false);
  });
});
