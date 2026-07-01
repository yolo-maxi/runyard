import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonApiClient } from "./http-client.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-hb-auth-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_hb_admin";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");
const { registerRunner, heartbeatRunner, getRunner } = await import("../src/db.js");

let server;
let baseUrl;
const token = "shub_hb_admin";
const api = createJsonApiClient({ baseUrl: () => baseUrl, token });

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

describe("runner auth health via heartbeat", () => {
  it("stores the latest health and surfaces it on GET /api/runners, stripping token material", async () => {
    const runner = registerRunner({ name: "hb-runner", tags: ["smithers", "reauth"], capacity: 1 }, "tok-hb");
    // A runner posts auth health plus (maliciously) token material — only the
    // whitelisted scalar fields must survive.
    heartbeatRunner(runner.id, {
      capacity: 1,
      activeRuns: 0,
      auth: {
        codex: { ok: true, expiresAt: "2030-01-01T00:00:00.000Z", accountId: "acct_1", access_token: "LEAK-CODEX" },
        claude: { ok: false, expiresAt: "2020-01-01T00:00:00.000Z", refreshToken: "LEAK-CLAUDE" },
        checkedAt: "2026-01-01T00:00:00.000Z"
      }
    });

    const stored = getRunner(runner.id);
    assert.equal(stored.authHealth.codex.ok, true);
    assert.equal(stored.authHealth.codex.accountId, "acct_1");
    assert.equal(stored.authHealth.claude.ok, false);
    assert.ok(!("access_token" in stored.authHealth.codex));
    assert.ok(!("refreshToken" in stored.authHealth.claude));

    const list = await api("/api/runners");
    const surfaced = list.runners.find((r) => r.id === runner.id);
    assert.ok(surfaced.authHealth);
    assert.equal(surfaced.authHealth.codex.ok, true);
    assert.ok(surfaced.health);
    assert.equal(surfaced.health.state, "degraded");
    assert.ok(surfaced.health.issues.some((issue) => issue.includes("claude auth")));
    // No token material anywhere in the API response.
    assert.ok(!JSON.stringify(list).includes("LEAK"));
  });

  it("surfaces the hub claim-auth fault (online-but-can't-claim) and strips any token material", () => {
    const runner = registerRunner({ name: "hb-runner-hub", tags: ["smithers"], capacity: 1 }, "tok-hb-hub");
    heartbeatRunner(runner.id, {
      capacity: 1,
      activeRuns: 0,
      auth: {
        claude: { ok: true },
        // Runner reports it is registered/online but every claim is rejected.
        hub: { ok: false, error: "HTTP 401: unauthorized", access_token: "LEAK-HUB" },
        checkedAt: "2026-06-26T00:00:00.000Z"
      }
    });
    const stored = getRunner(runner.id);
    assert.ok(stored.authHealth.hub, "hub auth status surfaced");
    assert.equal(stored.authHealth.hub.ok, false);
    assert.equal(stored.authHealth.hub.error, "HTTP 401: unauthorized");
    assert.equal(stored.health.state, "unhealthy");
    assert.ok(stored.health.score < 100);
    assert.ok(!("access_token" in stored.authHealth.hub), "no token material survives");
  });

  it("keeps the last known health when a heartbeat omits auth", async () => {
    const runner = registerRunner({ name: "hb-runner-2", tags: ["smithers"], capacity: 1 }, "tok-hb2");
    heartbeatRunner(runner.id, { auth: { codex: { ok: true }, claude: { ok: true } } });
    heartbeatRunner(runner.id, { capacity: 1, activeRuns: 0 }); // no auth field
    const stored = getRunner(runner.id);
    assert.equal(stored.authHealth.codex.ok, true);
  });
});
