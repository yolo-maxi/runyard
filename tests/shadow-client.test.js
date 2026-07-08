import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// End-to-end proof that a REAL external client — scripts/shadow-client.mjs,
// which consumes only /openapi.json and the HTTP API and never imports server
// internals — can rebuild the app's informational dashboard with a read-only
// token, is refused every mutation on that token, and can perform a safe
// mutation (create + discard a run draft) once given a mutation scope. The
// client runs as a separate process; only this harness touches internals.

const execFileAsync = promisify(execFile);

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-shadow-client-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");

const adminToken = "shub_test_token";
let server;
let baseUrl;
let readToken;
let writeToken;

async function mint(name, scopes) {
  const response = await fetch(`${baseUrl}/api/tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, scopes })
  });
  assert.equal(response.status, 200);
  return (await response.json()).token.token;
}

async function shadowClient(token, mode) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/shadow-client.mjs",
      "--base-url", baseUrl,
      "--token", token,
      "--mode", mode
    ], { cwd: process.cwd() });
    return { exitCode: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { exitCode: error.code ?? 1, report: error.stdout ? JSON.parse(error.stdout) : null };
  }
}

describe("shadow client (external API consumer)", () => {
  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
    readToken = await mint("shadow-read", ["read"]);
    writeToken = await mint("shadow-write", ["api", "mcp", "approvals"]);
  });

  after(() => server?.close());

  it("rebuilds the informational dashboard with a read-only token", async () => {
    const { exitCode, report } = await shadowClient(readToken, "read");
    assert.equal(exitCode, 0, JSON.stringify(report?.steps, null, 2));
    assert.equal(report.ok, true);
    const byName = new Map(report.steps.map((step) => [step.name, step]));
    assert.deepEqual(byName.get("openapi").groups, ["admin", "approvals", "automation", "distribution", "library", "runs", "system", "workflows"]);
    assert.ok(byName.get("openapi").v1PathCount >= 60);
    assert.deepEqual(byName.get("whoami").scopes, ["read"]);
    assert.ok(byName.get("menu").tools > 20, "menu lists MCP tools");
    assert.ok(byName.get("workflows").count > 0, "workflow catalog is visible");
    for (const name of ["runs", "approvals", "schedules", "runners", "dashboard", "llms.txt", "docs"]) {
      assert.equal(byName.get(name)?.ok, true, `${name} step failed`);
    }
    // Every mutation probe was refused with 403 insufficient scope.
    assert.equal(byName.get("read-only-denied-mutations")?.ok, true);
    for (const denial of report.mutationDenials) {
      assert.equal(denial.status, 403, `${denial.method} ${denial.pathname}`);
      assert.equal(denial.error, "insufficient scope");
    }
  });

  it("performs a safe mutation (create + discard draft) with a write-scoped token", async () => {
    const { exitCode, report } = await shadowClient(writeToken, "write");
    assert.equal(exitCode, 0, JSON.stringify(report?.steps, null, 2));
    const byName = new Map(report.steps.map((step) => [step.name, step]));
    assert.equal(byName.get("draft-created").status, 201);
    assert.equal(byName.get("draft-discarded").status, 200);
  });

  it("fails write mode on a read-only token — mutation scopes are really separate", async () => {
    const { exitCode, report } = await shadowClient(readToken, "write");
    assert.equal(exitCode, 1);
    assert.equal(report.ok, false);
    const created = report.steps.find((step) => step.name === "draft-created");
    assert.equal(created.status, 403, "draft creation must be forbidden for read-only");
  });
});
