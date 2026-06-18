import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";

const { app } = await import("../src/server.js");

let server;
let baseUrl;
const token = "shub_test_token";

function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  });
}

// Raw request that returns status without throwing, with an optional bearer token override.
function raw(pathname, options = {}, bearer = token) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("Smithers Hub API", () => {
  it("authenticates with bootstrap token", async () => {
    const data = await api("/api/me");
    assert.equal(data.token.name, "bootstrap-admin");
  });

  it("lists seeded capabilities, agents, skills, and knowledge", async () => {
    const caps = await api("/api/capabilities");
    const agents = await api("/api/agents");
    const skills = await api("/api/skills");
    const knowledge = await api("/api/knowledge");
    assert.ok(caps.capabilities.find((cap) => cap.slug === "hello"));
    assert.ok(agents.agents.length >= 4);
    assert.ok(skills.skills.length >= 4);
    assert.ok(knowledge.knowledge.length >= 1);
  });

  it("creates a run, registers a runner, claims it, stores events and artifacts, and completes", async () => {
    const created = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: { input: { goal: "Test Smithers Hub" } }
    });
    assert.equal(created.run.status, "queued");
    const runner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "test runner", hostname: "test", platform: "linux", tags: ["smithers", "node"] }
    });
    const assignment = await api(`/api/runners/${runner.runner.id}/next-run`);
    assert.equal(assignment.run.id, created.run.id);
    await api(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} });
    await api(`/api/runs/${created.run.id}/events`, { method: "POST", body: { type: "workflow.step", message: "testing" } });
    await api(`/api/runs/${created.run.id}/artifacts`, {
      method: "POST",
      body: { name: "result.md", mimeType: "text/markdown", contentBase64: Buffer.from("# result").toString("base64") }
    });
    await api(`/api/runs/${created.run.id}/complete`, { method: "POST", body: { output: { ok: true } } });
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "succeeded");
    assert.equal(detail.artifacts.length, 1);
    assert.equal(readFileSync(detail.artifacts[0].path, "utf8"), "# result");
  });

  it("requires approval for implement and resolves through API", async () => {
    const created = await api("/api/capabilities/implement/run", {
      method: "POST",
      body: { input: { repo: "/tmp", task: "test" } }
    });
    assert.equal(created.run.status, "waiting_approval");
    const approvals = await api("/api/approvals?status=pending");
    const approval = approvals.approvals.find((item) => item.runId === created.run.id);
    assert.ok(approval);
    await api(`/api/approvals/${approval.id}/approve`, { method: "POST", body: { comment: "ok" } });
    const detail = await api(`/api/runs/${created.run.id}`);
    assert.equal(detail.run.status, "queued");
  });
});

describe("Hardening: scopes, tokens, run state, webhook, health", () => {
  it("exposes an unauthenticated health endpoint", async () => {
    const res = await raw("/healthz", {}, null);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "ok");
  });

  it("enforces token scopes", async () => {
    // A read/run-only token (mcp) must not be able to mint tokens or edit the catalog.
    const created = await api("/api/tokens", { method: "POST", body: { name: "mcp-only", scopes: ["mcp"] } });
    const mcpToken = created.token.token;
    assert.ok(mcpToken);

    // Allowed: read capabilities and run them.
    const list = await raw("/api/capabilities", {}, mcpToken);
    assert.equal(list.status, 200);
    const run = await raw("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "scoped" } } }, mcpToken);
    assert.equal(run.status, 202);

    // Denied: minting tokens and editing the catalog require admin.
    const mint = await raw("/api/tokens", { method: "POST", body: { name: "evil", scopes: ["admin"] } }, mcpToken);
    assert.equal(mint.status, 403);
    const edit = await raw("/api/capabilities", { method: "POST", body: { name: "x" } }, mcpToken);
    assert.equal(edit.status, 403);
  });

  it("lists and revokes tokens, and revoked tokens stop working", async () => {
    const created = await api("/api/tokens", { method: "POST", body: { name: "throwaway", scopes: ["api", "mcp"] } });
    const id = created.token.id;
    const value = created.token.token;
    assert.equal((await raw("/api/me", {}, value)).status, 200);

    const list = await api("/api/tokens");
    assert.ok(list.tokens.find((entry) => entry.id === id && entry.active));

    await api(`/api/tokens/${id}`, { method: "DELETE" });
    assert.equal((await raw("/api/me", {}, value)).status, 401);
  });

  it("refuses to revoke the last active admin token", async () => {
    const me = await api("/api/me");
    const res = await raw(`/api/tokens/${me.token.id}`, { method: "DELETE" });
    assert.equal(res.status, 409);
  });

  it("guards run state transitions", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "state" } } });
    const runId = created.run.id;
    await api(`/api/runs/${runId}/cancel`, { method: "POST", body: { reason: "stop" } });
    // Cannot complete a cancelled run.
    const complete = await raw(`/api/runs/${runId}/complete`, { method: "POST", body: { output: {} } });
    assert.equal(complete.status, 409);
    // Re-cancelling a cancelled run is idempotent.
    const reCancel = await raw(`/api/runs/${runId}/cancel`, { method: "POST", body: {} });
    assert.equal(reCancel.status, 200);
    assert.equal(reCancel.data.run.status, "cancelled");
  });

  it("does not double-assign a queued run to two runners", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "claim" } } });
    const a = await api("/api/runners/register", { method: "POST", body: { name: "a", hostname: "a", tags: ["smithers", "node"] } });
    const b = await api("/api/runners/register", { method: "POST", body: { name: "b", hostname: "b", tags: ["smithers", "node"] } });
    const claimA = await api(`/api/runners/${a.runner.id}/next-run`);
    const claimB = await api(`/api/runners/${b.runner.id}/next-run`);
    const claimed = [claimA, claimB].filter((c) => c.run && c.run.id === created.run.id);
    assert.equal(claimed.length, 1);
  });

  it("serves a one-line installer and a client bundle", async () => {
    const r1 = await fetch(`${baseUrl}/install.sh`);
    assert.equal(r1.status, 200);
    const body = await r1.text();
    assert.match(body, /Installing Smithers Hub client/);
    assert.match(body, /\/cli\.tgz/);
    assert.match(body, /smithers-hub mcp install/);
    const r2 = await fetch(`${baseUrl}/cli.tgz`);
    assert.equal(r2.status, 200);
    const buf = Buffer.from(await r2.arrayBuffer());
    assert.equal(buf[0], 0x1f); // gzip magic
    assert.equal(buf[1], 0x8b);
  });

  it("rejects unconfigured / unauthenticated Telegram webhook calls", async () => {
    // No TELEGRAM_WEBHOOK_SECRET configured in the test env -> endpoint disabled.
    const res = await raw("/api/telegram/webhook", { method: "POST", body: { callback_query: { data: "approve:appr_x" } } }, null);
    assert.equal(res.status, 503);
  });

  it("has a readiness probe and run pagination metadata", async () => {
    assert.equal((await raw("/readyz", {}, null)).status, 200);
    const runs = await api("/api/runs?limit=5");
    assert.equal(typeof runs.total, "number");
    assert.equal(runs.limit, 5);
  });

  it("records an audit trail for token creation", async () => {
    const created = await api("/api/tokens", { method: "POST", body: { name: "audited", scopes: ["api"] } });
    const audit = await api("/api/audit");
    assert.ok(audit.audit.find((entry) => entry.action === "token.created" && entry.target === created.token.id));
  });

  it("blocks runners from touching runs they do not own", async () => {
    const created = await api("/api/capabilities/hello/run", { method: "POST", body: { input: { goal: "owner" } } });
    const runnerToken = (await api("/api/tokens", { method: "POST", body: { name: "runner-only", scopes: ["runner"] } })).token.token;
    // Has runner scope, but does not own this (unassigned) run -> 403.
    const start = await raw(`/api/runs/${created.run.id}/start`, { method: "POST", body: {} }, runnerToken);
    assert.equal(start.status, 403);
  });

  it("does not let a runner token hijack another runner's id", async () => {
    const runnerToken = (await api("/api/tokens", { method: "POST", body: { name: "rt", scopes: ["runner"] } })).token.token;
    const mine = await raw("/api/runners/register", { method: "POST", body: { name: "mine", tags: ["smithers", "node"] } }, runnerToken);
    const myId = mine.data.runner.id;
    // A different token (admin) tries to register using my runner id -> must NOT overwrite mine.
    const other = await api("/api/runners/register", { method: "POST", body: { id: myId, name: "hijack", tags: ["smithers", "node"] } });
    assert.notEqual(other.runner.id, myId);
  });
});
