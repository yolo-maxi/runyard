import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createJsonApiClient } from "./http-client.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-secrets-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_secrets_admin";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";
process.env.SECRETS_ENC_KEY = randomBytes(32).toString("base64");

const { app } = await import("../src/server.js");
const { createRun, getCapability, getDecryptedSecretEnv, secretNamesForRun, claimNextRun, registerRunner } =
  await import("../src/db.js");

let server;
let baseUrl;
const adminToken = "shub_secrets_admin";
let readToken;
const statusApi = createJsonApiClient({
  baseUrl: () => baseUrl,
  token: adminToken,
  throwOnError: false,
  includeStatus: true
});

function req(pathname, options = {}, bearer = adminToken) {
  return statusApi(pathname, { ...options, token: bearer });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  // Mint a non-admin (api-scoped) token via the admin API. Token creation
  // validates scopes against the known set, so a made-up scope would 400.
  const created = await req("/api/tokens", { method: "POST", body: { name: "read-only", scopes: ["api"] } });
  readToken = created.data.token.token;
  assert.ok(readToken, "expected a non-admin token to be issued");
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("secrets API — admin scope + write-only values", () => {
  it("starts empty and reports enabled", async () => {
    const res = await req("/api/secrets");
    assert.equal(res.status, 200);
    assert.equal(res.data.enabled, true);
    assert.deepEqual(res.data.secrets, []);
  });

  it("upserts an encrypted secret and never echoes the value back", async () => {
    const value = "ghp_TOPSECRET_DEADBEEF_0001";
    const put = await req("/api/secrets/GITHUB_TOKEN", { method: "PUT", body: { value, description: "GitHub PAT" } });
    assert.equal(put.status, 201);
    assert.equal(put.data.secret.key, "GITHUB_TOKEN");
    assert.equal(put.data.secret.description, "GitHub PAT");
    // The value must never appear in the create response.
    assert.ok(!JSON.stringify(put.data).includes("DEADBEEF"));

    const list = await req("/api/secrets");
    assert.equal(list.status, 200);
    const found = list.data.secrets.find((s) => s.key === "GITHUB_TOKEN");
    assert.ok(found);
    assert.equal(found.description, "GitHub PAT");
    // No value/value_encrypted anywhere in the list payload.
    assert.ok(!JSON.stringify(list.data).includes("DEADBEEF"));
    assert.ok(!("value" in found));
    assert.ok(!("valueEncrypted" in found));
  });

  it("rejects an invalid key and an empty value", async () => {
    assert.equal((await req("/api/secrets/has spaces", { method: "PUT", body: { value: "x1234" } })).status, 400);
    assert.equal((await req("/api/secrets/OK_KEY", { method: "PUT", body: { value: "" } })).status, 400);
  });

  it("deletes a secret", async () => {
    await req("/api/secrets/TO_DELETE", { method: "PUT", body: { value: "delete-me-1234" } });
    const del = await req("/api/secrets/TO_DELETE", { method: "DELETE" });
    assert.equal(del.status, 200);
    const list = await req("/api/secrets");
    assert.ok(!list.data.secrets.find((s) => s.key === "TO_DELETE"));
  });
});

describe("secrets API — non-admin token is forbidden (403)", () => {
  it("403s on list, upsert, and delete for a non-admin token", async () => {
    assert.equal((await req("/api/secrets", {}, readToken)).status, 403);
    assert.equal(
      (await req("/api/secrets/NOPE", { method: "PUT", body: { value: "should-fail-1234" } }, readToken)).status,
      403
    );
    assert.equal((await req("/api/secrets/GITHUB_TOKEN", { method: "DELETE" }, readToken)).status, 403);
    // And the read token cannot read a value through any of these.
  });
});

describe("secret injection + scrubbing", () => {
  it("decrypts only the allowlisted names for a run claim", async () => {
    await req("/api/secrets/INJECT_ME", { method: "PUT", body: { value: "inject-value-CAFEBABE" } });
    await req("/api/secrets/NOT_ALLOWED", { method: "PUT", body: { value: "nope-value-9999" } });
    const env = getDecryptedSecretEnv(["INJECT_ME"]);
    assert.equal(env.INJECT_ME, "inject-value-CAFEBABE");
    assert.ok(!("NOT_ALLOWED" in env));
    // Allowlist resolution from capability.workflow.secrets + input.secretNames.
    const names = secretNamesForRun({ workflow: { secrets: ["INJECT_ME"] } }, { secretNames: ["EXTRA"] });
    assert.deepEqual(new Set(names), new Set(["INJECT_ME", "EXTRA"]));
  });

  it("includes secretEnv in the runner claim payload but never in stored run input", async () => {
    const capability = { ...getCapability("hello"), workflow: { engine: "smithers", entry: ".smithers/workflows/hello.tsx", secrets: ["INJECT_ME"] } };
    // Persist the workflow.secrets allowlist on the capability so claim resolves it.
    const { upsertCapability } = await import("../src/db.js");
    upsertCapability(capability);
    const cap = getCapability("hello");
    const run = createRun(cap, { topic: "x" });
    const runner = registerRunner({ name: "secrets-runner", tags: ["smithers"], capacity: 1 }, "tok-secrets");
    const claim = claimNextRun(runner.id);
    assert.ok(claim, "expected a claim");
    assert.equal(claim.secretEnv.INJECT_ME, "inject-value-CAFEBABE");
    // Stored run input must not contain the secret VALUE.
    assert.ok(!JSON.stringify(run.input).includes("CAFEBABE"));
    assert.ok(!JSON.stringify(claim.run.input).includes("CAFEBABE"));
  });

  it("scrubs an injected secret value out of stored run output", async () => {
    const secretValue = "scrub-me-FACEFEED-0xdead";
    await req("/api/secrets/SCRUB_TOKEN", { method: "PUT", body: { value: secretValue } });
    const cap = getCapability("hello");
    const run = createRun(cap, { topic: "scrub" });
    // Move queued -> running so /complete (running -> succeeded) is allowed.
    await req(`/api/runs/${run.id}/start`, { method: "POST", body: {} });
    const complete = await req(`/api/runs/${run.id}/complete`, {
      method: "POST",
      body: { output: { answer: `the token is ${secretValue} do not leak`, nested: { v: secretValue } } }
    });
    assert.equal(complete.status, 200);
    const detail = await req(`/api/runs/${run.id}`);
    const serialized = JSON.stringify(detail.data);
    assert.ok(!serialized.includes("FACEFEED"), "secret value must be scrubbed from stored output");
    assert.ok(serialized.includes("[redacted:secret]"));
  });

  it("scrubs a secret value pasted directly into run input", async () => {
    const secretValue = "scrub-me-FACEFEED-0xdead"; // same as above secret
    const cap = getCapability("hello");
    const run = createRun(cap, { topic: "x", pasted: `oops ${secretValue}` });
    assert.ok(!JSON.stringify(run.input).includes("FACEFEED"));
  });
});

describe("secrets API — disabled when no key configured (503)", () => {
  it("returns 503 on every secrets route when SECRETS_ENC_KEY is unset", async () => {
    const prev = process.env.SECRETS_ENC_KEY;
    delete process.env.SECRETS_ENC_KEY;
    try {
      assert.equal((await req("/api/secrets")).status, 503);
      assert.equal((await req("/api/secrets/X", { method: "PUT", body: { value: "y1234" } })).status, 503);
      assert.equal((await req("/api/secrets/X", { method: "DELETE" })).status, 503);
    } finally {
      process.env.SECRETS_ENC_KEY = prev;
    }
  });
});
