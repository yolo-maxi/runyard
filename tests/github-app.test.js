import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";

import {
  createGitHubApp,
  githubAppConfigHealth,
  githubAppConfigured,
  githubAppJwt,
  validateGithubApiBase,
  verifyGithubWebhookSignature
} from "../src/githubApp.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });

function appEnv(overrides = {}) {
  return {
    githubAppId: "1234",
    githubAppPrivateKeyPath: "",
    githubAppPrivateKey: privatePem,
    githubWebhookSecret: "hooksecret",
    githubApiBase: "https://api.github.com",
    githubAppSlug: "runyard-ci",
    ...overrides
  };
}

function fakeResponse(status, data, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => data
  };
}

describe("github app jwt", () => {
  it("produces a verifiable RS256 JWT with app id issuer and <=10 minute lifetime", () => {
    const nowMs = 1750000000000;
    const jwt = githubAppJwt({ appId: "1234", privateKey: privatePem, nowMs });
    const [header, payload, signature] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    assert.equal(verifier.verify(publicPem, Buffer.from(signature, "base64url")), true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.iss, "1234");
    assert.equal(claims.iat, Math.floor(nowMs / 1000) - 60);
    assert.ok(claims.exp - claims.iat <= 600, "JWT lifetime must stay within GitHub's 10 minute cap");
  });
});

describe("webhook signature verification", () => {
  const rawBody = Buffer.from(JSON.stringify({ zen: "Design for failure." }));
  const goodSignature = `sha256=${createHmac("sha256", "hooksecret").update(rawBody).digest("hex")}`;

  it("accepts the exact HMAC over the raw body", () => {
    assert.equal(verifyGithubWebhookSignature({ secret: "hooksecret", rawBody, signatureHeader: goodSignature }), true);
  });

  it("rejects wrong secret, tampered body, malformed and missing headers", () => {
    assert.equal(verifyGithubWebhookSignature({ secret: "other", rawBody, signatureHeader: goodSignature }), false);
    assert.equal(
      verifyGithubWebhookSignature({ secret: "hooksecret", rawBody: Buffer.from("{}"), signatureHeader: goodSignature }),
      false
    );
    assert.equal(verifyGithubWebhookSignature({ secret: "hooksecret", rawBody, signatureHeader: "sha1=abc" }), false);
    assert.equal(verifyGithubWebhookSignature({ secret: "hooksecret", rawBody, signatureHeader: undefined }), false);
    assert.equal(verifyGithubWebhookSignature({ secret: "", rawBody, signatureHeader: goodSignature }), false);
  });
});

describe("config health", () => {
  it("reports configuration state without ever including secret material", () => {
    const health = githubAppConfigHealth(appEnv());
    assert.equal(health.configured, true);
    assert.equal(health.privateKeySource, "inline");
    assert.equal(health.webhookSecretConfigured, true);
    const serialized = JSON.stringify(health);
    assert.doesNotMatch(serialized, /PRIVATE KEY|hooksecret/);
    assert.equal(githubAppConfigured(appEnv({ githubWebhookSecret: "" })), false);
  });

  it("validates the API base against SSRF-shaped overrides", () => {
    assert.equal(validateGithubApiBase("https://api.github.com").ok, true);
    assert.equal(validateGithubApiBase("http://127.0.0.1:9999").ok, true);
    assert.equal(validateGithubApiBase("http://169.254.169.254/latest").ok, false);
    assert.equal(validateGithubApiBase("file:///etc/passwd").ok, false);
    assert.equal(validateGithubApiBase("not a url").ok, false);
  });
});

describe("installation tokens", () => {
  it("mints just in time, caches until near expiry, and never persists", async () => {
    const calls = [];
    let now = 1750000000000;
    const app = createGitHubApp({
      env: appEnv(),
      nowMs: () => now,
      sleep: async () => {},
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return fakeResponse(201, {
          token: `ghs_test_${calls.length}`,
          expires_at: new Date(now + 60 * 60_000).toISOString()
        });
      }
    });
    const first = await app.installationToken(42);
    const second = await app.installationToken(42);
    assert.equal(first, second, "token is cached within its lifetime");
    assert.equal(calls.length, 1);

    now += 58 * 60_000; // inside the 5-minute refresh margin
    const third = await app.installationToken(42);
    assert.notEqual(third, first, "token is re-minted near expiry");
    assert.equal(calls.length, 2);

    // Differently-scoped requests never share a cache entry.
    await app.installationToken(42, { repositories: ["runyard"], permissions: { checks: "write" } });
    assert.equal(calls.length, 3);
    const scoped = JSON.parse(calls[2].options.body);
    assert.deepEqual(scoped.repositories, ["runyard"]);
    assert.deepEqual(scoped.permissions, { checks: "write" });
  });

  it("refuses to operate unconfigured", async () => {
    const app = createGitHubApp({ env: appEnv({ githubAppId: "" }) });
    await assert.rejects(() => app.installationToken(42), /not configured/);
  });
});

describe("request retry/backoff", () => {
  it("retries 5xx and secondary rate limits, then succeeds", async () => {
    const statuses = [
      [500, {}, {}],
      [403, { message: "rate limited" }, { "x-ratelimit-remaining": "0", "retry-after": "1" }],
      [200, { ok: true }, {}]
    ];
    let attempt = 0;
    const slept = [];
    const app = createGitHubApp({
      env: appEnv(),
      sleep: async (ms) => slept.push(ms),
      fetchImpl: async () => {
        const [status, data, headers] = statuses[attempt++];
        return fakeResponse(status, data, headers);
      }
    });
    const { data } = await app.request("GET", "/rate-limit");
    assert.deepEqual(data, { ok: true });
    assert.equal(attempt, 3);
    assert.equal(slept.length, 2);
  });

  it("surfaces a terminal error with status after exhausting retries", async () => {
    const app = createGitHubApp({
      env: appEnv(),
      sleep: async () => {},
      fetchImpl: async () => fakeResponse(502, { message: "bad gateway" })
    });
    await assert.rejects(
      () => app.request("GET", "/repos/o/r/check-runs"),
      (error) => error.status === 502
    );
  });

  it("mints a repo-scoped read-only git fetch token", async () => {
    const bodies = [];
    const app = createGitHubApp({
      env: appEnv(),
      sleep: async () => {},
      fetchImpl: async (url, options) => {
        bodies.push({ url, body: options.body ? JSON.parse(options.body) : null });
        return fakeResponse(201, { token: "ghs_git", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
    });
    const token = await app.gitFetchToken(42, "runyard");
    assert.equal(token, "ghs_git");
    assert.deepEqual(bodies[0].body, { repositories: ["runyard"], permissions: { contents: "read" } });
  });
});
