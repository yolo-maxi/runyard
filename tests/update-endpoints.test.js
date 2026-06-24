import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-update-ep-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_update_admin";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";
// Pin the version triple so /version is deterministic regardless of git state.
process.env.RUNYARD_GIT_TAG = "v0.1.0";
process.env.RUNYARD_GIT_COMMIT = "deadbee";

const { app, setUpdateCheckerForTest } = await import("../src/server.js");
const { env } = await import("../src/env.js");
const { createAccessToken, recordAlert, latestAlert, listAlerts } = await import("../src/db.js");

let server;
let baseUrl;
const adminToken = "shub_update_admin";

function req(pathname, { method = "GET", token, body } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (res) => {
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
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

describe("GET /version", () => {
  it("returns { version, gitTag, gitCommit } unauthenticated and leaks nothing sensitive", async () => {
    const { status, data } = await req("/version");
    assert.equal(status, 200);
    assert.equal(typeof data.version, "string");
    assert.ok(data.version.length > 0);
    assert.equal(data.version, env.version);
    assert.equal(data.gitTag, "v0.1.0");
    assert.equal(data.gitCommit, "deadbee");
    // No stray fields that could leak secrets/paths.
    assert.deepEqual(Object.keys(data).sort(), ["gitCommit", "gitTag", "version"]);
  });
});

describe("GET /api/update-status (admin only)", () => {
  it("reflects the cached checker result for an admin", async () => {
    setUpdateCheckerForTest({
      getCached: () => ({
        latest: "9.9.9",
        latestTag: "v9.9.9",
        updateAvailable: true,
        status: "ok",
        checkedAt: 1_700_000_000_000
      }),
      check: async () => {}
    });
    const { status, data } = await req("/api/update-status", { token: adminToken });
    assert.equal(status, 200);
    assert.equal(data.current, env.version);
    assert.equal(data.latest, "9.9.9");
    assert.equal(data.updateAvailable, true);
    assert.equal(data.status, "ok");
    assert.equal(data.applyEnabled, false, "HTTP apply is off by default");
    assert.ok(data.checkedAt, "checkedAt should serialize to an ISO timestamp");
  });

  it("rejects a non-admin token with 403", async () => {
    const { token } = createAccessToken("api-only", undefined, ["api"]);
    const { status } = await req("/api/update-status", { token });
    assert.equal(status, 403);
  });

  it("requires auth", async () => {
    const { status } = await req("/api/update-status");
    assert.equal(status, 401);
  });
});

describe("POST /api/update/apply (admin + opt-in)", () => {
  it("is 503 when UPDATE_APPLY_ENABLED is off (the safe default)", async () => {
    const { status, data } = await req("/api/update/apply", { method: "POST", token: adminToken, body: {} });
    assert.equal(status, 503);
    assert.equal(data.applyEnabled, false);
  });

  it("rejects a non-admin even when enabled", async () => {
    const prev = env.updateApplyEnabled;
    env.updateApplyEnabled = true;
    try {
      const { token } = createAccessToken("api-only-2", undefined, ["api"]);
      const { status } = await req("/api/update/apply", { method: "POST", token, body: {} });
      assert.equal(status, 403);
    } finally {
      env.updateApplyEnabled = prev;
    }
  });

  it("validates the target tag and never spawns when the script is absent", async () => {
    const prevEnabled = env.updateApplyEnabled;
    const prevRoot = env.root;
    env.updateApplyEnabled = true;
    env.root = temp; // a dir with no scripts/runyard-update.sh -> 500 before any spawn
    try {
      const bad = await req("/api/update/apply", { method: "POST", token: adminToken, body: { tag: "not-a-tag; rm -rf /" } });
      assert.equal(bad.status, 400, "a malformed/injection-y tag is rejected");
      const ok = await req("/api/update/apply", { method: "POST", token: adminToken, body: { tag: "v1.2.3" } });
      assert.equal(ok.status, 500, "valid tag but missing script -> 500, not a spawn against the live repo");
      assert.match(ok.data.error, /update script not found/);
    } finally {
      env.updateApplyEnabled = prevEnabled;
      env.root = prevRoot;
    }
  });
});

describe("_smithers_alerts surfacing", () => {
  it("records an update outcome and surfaces it via the API + lastOutcome", async () => {
    recordAlert({
      kind: "update",
      level: "error",
      title: "Update failed",
      message: "Update to v9.9.9 failed (healthcheck); rolled back to v0.1.0 and healthy.",
      data: { status: "failed", from: "v9.9.9", to: "v0.1.0" }
    });
    const latest = latestAlert("update");
    assert.equal(latest.level, "error");
    assert.match(latest.message, /rolled back/);

    const status = await req("/api/update-status", { token: adminToken });
    assert.equal(status.data.lastOutcome.level, "error");
    assert.match(status.data.lastOutcome.message, /rolled back/);

    const alerts = await req("/api/alerts?kind=update", { token: adminToken });
    assert.equal(alerts.status, 200);
    assert.ok(alerts.data.alerts.length >= 1);
    assert.equal(alerts.data.alerts[0].kind, "update");
  });

  it("listAlerts respects the limit and ordering (newest first)", () => {
    recordAlert({ kind: "update", level: "info", title: "a", message: "first" });
    recordAlert({ kind: "update", level: "success", title: "b", message: "second" });
    const rows = listAlerts({ kind: "update", limit: 1 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message, "second");
  });
});
