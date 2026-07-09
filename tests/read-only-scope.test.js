import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A token whose only scope is `read` must be able to inspect the deployment
// (reads require authentication, not a scope) while failing every scope-gated
// mutation with 403 — that property is the whole point of the read-only
// preset on the Tokens page. This boots the real server and drives it over
// HTTP with real minted tokens, on canonical and /api/v1 alias paths.

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-read-only-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");
const { createJsonApiClient } = await import("./http-client.js");

const adminToken = "shub_test_token";
let server;
let baseUrl;
let readToken;

const api = createJsonApiClient({
  baseUrl: () => baseUrl,
  token: () => readToken,
  throwOnError: false,
  includeStatus: true
});

describe("read-only scope", () => {
  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
    const minted = await api("/api/tokens", {
      method: "POST",
      token: adminToken,
      body: { name: "read-only monitor", scopes: ["read"] }
    });
    assert.equal(minted.status, 200, "admin can mint a read-scoped token");
    assert.deepEqual(minted.data.token.scopes, ["read"]);
    readToken = minted.data.token.token;
  });

  after(() => server?.close());

  it("reads representative state on canonical and /api/v1 paths", async () => {
    const reads = [
      "/api/me",
      "/api/menu",
      "/api/workflows",
      "/api/runs",
      "/api/approvals",
      "/api/schedules",
      "/api/runners",
      "/api/dashboard",
      "/api/hooks",
      "/api/artifacts",
      "/api/run-drafts",
      "/api/v1/system/menu",
      "/api/v1/workflows",
      "/api/v1/runs",
      "/api/v1/approvals",
      "/api/v1/automation/schedules",
      "/api/v1/system/dashboard",
      "/api/v1/runs/drafts"
    ];
    for (const pathname of reads) {
      const { status } = await api(pathname);
      assert.equal(status, 200, `read-only token should read ${pathname}`);
    }
    const me = await api("/api/me");
    assert.deepEqual(me.data.token.scopes, ["read"]);
  });

  it("cannot mutate: every representative write fails with 403 insufficient scope", async () => {
    const writes = [
      { method: "POST", path: "/api/workflows", body: { name: "x" } },
      { method: "POST", path: "/api/workflows/improve/run", body: { input: {} } },
      { method: "POST", path: "/api/workflows/improve/preflight", body: { input: {} } },
      { method: "POST", path: "/api/run-drafts", body: { workflow: "improve", input: {} } },
      { method: "POST", path: "/api/schedules", body: { name: "x" } },
      { method: "POST", path: "/api/tokens", body: { name: "escalation", scopes: ["admin"] } },
      { method: "DELETE", path: "/api/tokens/whatever" },
      { method: "POST", path: "/api/approvals", body: { title: "x" } },
      { method: "POST", path: "/api/approvals/nope/approve" },
      { method: "POST", path: "/api/runs/nope/cancel" },
      { method: "POST", path: "/api/runs/nope/pause" },
      { method: "POST", path: "/api/runs/nope/resume" },
      { method: "POST", path: "/api/runs/nope/rerun" },
      { method: "POST", path: "/api/runs/nope/start" },
      { method: "PUT", path: "/api/secrets/some-key", body: { value: "v" } },
      { method: "POST", path: "/api/update/apply" },
      { method: "PATCH", path: "/api/agents/some-agent", body: {} },
      { method: "POST", path: "/api/v1/workflows/improve/run", body: { input: {} } },
      { method: "POST", path: "/api/v1/automation/schedules", body: { name: "x" } },
      { method: "POST", path: "/api/v1/admin/tokens", body: { name: "escalation", scopes: ["admin"] } },
      { method: "POST", path: "/api/v1/approvals/nope/approve" }
    ];
    for (const write of writes) {
      const { status, data } = await api(write.path, { method: write.method, body: write.body });
      assert.equal(status, 403, `${write.method} ${write.path} must be forbidden for read-only, got ${status}`);
      assert.equal(data.error, "insufficient scope", `${write.method} ${write.path}`);
    }
  });

  it("cannot read admin-only surfaces", async () => {
    for (const pathname of ["/api/tokens", "/api/audit", "/api/secrets", "/api/tokens/scopes"]) {
      const { status } = await api(pathname);
      assert.equal(status, 403, `read-only token must not read ${pathname}`);
    }
  });

  it("admin still reads the scope vocabulary and presets over HTTP", async () => {
    const { status, data } = await api("/api/tokens/scopes", { token: adminToken });
    assert.equal(status, 200);
    assert.ok(data.presets.find((preset) => preset.id === "read-only"));
    assert.ok(data.scopes.find((scope) => scope.scope === "read"));
    assert.deepEqual(data.defaultScopes, ["api", "mcp"]);
    const aliased = await api("/api/v1/admin/tokens/scopes", { token: adminToken });
    assert.equal(aliased.status, 200);
    assert.deepEqual(aliased.data, data);
  });
});
