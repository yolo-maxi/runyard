import { createSign, timingSafeEqual, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

// GitHub App primitives for the CI platform, on native crypto + fetch — the
// smallest dependency surface that fits RunYard's architecture (see
// specs/ci-platform.md). Three jobs:
//
//   1. RS256 App JWTs (10-minute lifetime, iss = app id).
//   2. Just-in-time installation access tokens: minted on demand, cached in
//      memory until shortly before expiry, NEVER persisted or logged.
//   3. A bounded REST helper with retry/backoff + rate-limit awareness, and
//      the Checks API calls the reporter needs.
//
// Everything external is injectable (fetchImpl, nowMs, sleep, readFile) so
// tests run fully offline against a fake GitHub.

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
// Refresh installation tokens 5 minutes before GitHub's 1h expiry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export function githubAppConfig(env) {
  return {
    appId: String(env.githubAppId || ""),
    privateKeyPath: env.githubAppPrivateKeyPath || "",
    privateKeyInline: env.githubAppPrivateKey || "",
    webhookSecret: env.githubWebhookSecret || "",
    apiBase: String(env.githubApiBase || "https://api.github.com").replace(/\/+$/, ""),
    appSlug: env.githubAppSlug || ""
  };
}

export function githubAppConfigured(env) {
  const config = githubAppConfig(env);
  return Boolean(config.appId && (config.privateKeyPath || config.privateKeyInline) && config.webhookSecret);
}

// Config health for the admin surface: which pieces are present — never any
// secret values, never key material.
export function githubAppConfigHealth(env) {
  const config = githubAppConfig(env);
  return {
    configured: githubAppConfigured(env),
    appId: config.appId || null,
    appSlug: config.appSlug || null,
    apiBase: config.apiBase,
    privateKeySource: config.privateKeyPath ? "path" : config.privateKeyInline ? "inline" : "missing",
    webhookSecretConfigured: Boolean(config.webhookSecret)
  };
}

// SSRF guard for the API base override: https anywhere, or http only to
// loopback (the offline test fake).
export function validateGithubApiBase(apiBase) {
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    return { ok: false, error: `invalid GitHub API base: ${apiBase}` };
  }
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return { ok: true };
  }
  return { ok: false, error: "GitHub API base must be https (http is allowed only for loopback test fakes)" };
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

// RS256 App JWT. iat is backdated 60s against clock drift; exp is capped at
// GitHub's 10-minute maximum.
export function githubAppJwt({ appId, privateKey, nowMs = Date.now() }) {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// Constant-time verification of x-hub-signature-256 over the exact raw body
// bytes. Returns false for missing/malformed headers rather than throwing.
export function verifyGithubWebhookSignature({ secret, rawBody, signatureHeader }) {
  if (!secret || !rawBody || typeof signatureHeader !== "string") return false;
  const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const presented = Buffer.from(match[1], "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

export function createGitHubApp({
  env,
  fetchImpl = fetch,
  nowMs = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readFile = readFileSync,
  logError = console.error
} = {}) {
  const config = githubAppConfig(env);
  // installationId + scope fingerprint -> { token, expiresAtMs }. Memory only.
  const tokenCache = new Map();

  function configured() {
    return githubAppConfigured(env);
  }

  function requireConfigured() {
    if (!configured()) throw new Error("GitHub App is not configured (app id, private key, webhook secret required)");
    const base = validateGithubApiBase(config.apiBase);
    if (!base.ok) throw new Error(base.error);
  }

  // Key material is read lazily per mint and held only on the stack.
  function privateKey() {
    if (config.privateKeyPath) return readFile(config.privateKeyPath, "utf8");
    return config.privateKeyInline;
  }

  function appJwt() {
    requireConfigured();
    return githubAppJwt({ appId: config.appId, privateKey: privateKey(), nowMs: nowMs() });
  }

  async function request(method, path, { body, auth, headers = {}, attempt = 1 } = {}) {
    const url = path.startsWith("http") ? path : `${config.apiBase}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "runyard-ci",
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * 2 ** (attempt - 1));
        return request(method, path, { body, auth, headers, attempt: attempt + 1 });
      }
      throw new Error(`GitHub request ${method} ${path} failed after ${attempt} attempts: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 204) return { status: response.status, data: null };
    const retryable = response.status >= 500 || response.status === 429 || rateLimited(response);
    if (retryable && attempt < MAX_ATTEMPTS) {
      await sleep(retryDelayMs(response, attempt, nowMs()));
      return request(method, path, { body, auth, headers, attempt: attempt + 1 });
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      // GitHub error messages are safe to surface; the auth header never is.
      const error = new Error(`GitHub ${method} ${path} -> ${response.status}${data?.message ? `: ${data.message}` : ""}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return { status: response.status, data };
  }

  function scopeFingerprint(scope = {}) {
    return JSON.stringify({
      repositories: [...(scope.repositories || [])].sort(),
      permissions: scope.permissions || null
    });
  }

  // Just-in-time installation token, scoped to the given repositories and
  // permissions. Cached in memory until shortly before expiry; never stored.
  async function installationToken(installationId, scope = {}) {
    requireConfigured();
    const cacheKey = `${installationId}:${scopeFingerprint(scope)}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > nowMs()) return cached.token;
    const body = {};
    if (scope.repositories?.length) body.repositories = scope.repositories;
    if (scope.permissions) body.permissions = scope.permissions;
    const { data } = await request("POST", `/app/installations/${installationId}/access_tokens`, {
      body: Object.keys(body).length ? body : undefined,
      auth: appJwt()
    });
    if (!data?.token) throw new Error("GitHub returned no installation token");
    tokenCache.set(cacheKey, {
      token: data.token,
      expiresAtMs: data.expires_at ? Date.parse(data.expires_at) : nowMs() + 55 * 60_000
    });
    return data.token;
  }

  async function listInstallations() {
    const { data } = await request("GET", "/app/installations?per_page=100", { auth: appJwt() });
    return Array.isArray(data) ? data : [];
  }

  async function listInstallationRepositories(installationId) {
    const token = await installationToken(installationId);
    const repos = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await request("GET", `/installation/repositories?per_page=100&page=${page}`, { auth: token });
      const batch = data?.repositories || [];
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    return repos;
  }

  async function createCheckRun({ installationId, owner, repo, payload }) {
    const token = await installationToken(installationId, {
      repositories: [repo],
      permissions: { checks: "write" }
    });
    const { data } = await request("POST", `/repos/${owner}/${repo}/check-runs`, { body: payload, auth: token });
    return data;
  }

  async function updateCheckRun({ installationId, owner, repo, checkRunId, payload }) {
    const token = await installationToken(installationId, {
      repositories: [repo],
      permissions: { checks: "write" }
    });
    const { data } = await request("PATCH", `/repos/${owner}/${repo}/check-runs/${checkRunId}`, { body: payload, auth: token });
    return data;
  }

  // Short-lived read-only token for git fetch of one repository. Rides the
  // runner claim's secretEnv channel (never stored); expires within an hour.
  async function gitFetchToken(installationId, repoName) {
    return installationToken(installationId, {
      repositories: [repoName],
      permissions: { contents: "read" }
    });
  }

  return {
    appJwt,
    config,
    configured,
    createCheckRun,
    gitFetchToken,
    installationToken,
    listInstallationRepositories,
    listInstallations,
    logError,
    request,
    updateCheckRun
  };
}

function rateLimited(response) {
  return response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
}

function retryDelayMs(response, attempt, nowMsValue) {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset * 1000 - nowMsValue;
    if (wait > 0) return Math.min(wait, 30_000);
  }
  return 1000 * 2 ** (attempt - 1);
}
