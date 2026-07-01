import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUpdaterEnv,
  createUpdateHandlers,
  launchUpdater,
  updateApplyPreflight,
  updateScriptPath,
  validUpdateTag
} from "../src/selfUpdateRoutes.js";
import { mockResponse as response } from "./response.js";

function req({ body = {}, query = {}, token = { name: "Admin" } } = {}) {
  return { body, query, token };
}

function baseEnv(overrides = {}) {
  return {
    root: "/srv/runyard",
    dataDir: "/var/lib/runyard",
    port: 7331,
    drainGraceMs: 1234,
    githubRepo: "owner/repo",
    updateApplyEnabled: false,
    updateCheckEnabled: true,
    updateNotifyWebhook: "",
    ...overrides
  };
}

function harness(overrides = {}) {
  const audits = [];
  const alerts = [];
  const checks = [];
  const env = baseEnv(overrides.env);
  const cached = overrides.cached || {
    latest: "9.9.9",
    latestTag: "v9.9.9",
    updateAvailable: true,
    status: "ok",
    checkedAt: 1_700_000_000_000
  };
  const handlers = createUpdateHandlers({
    env,
    exists: overrides.exists || (() => true),
    getUpdateChecker: () => ({
      getCached: () => cached,
      check: async (refresh) => checks.push(refresh)
    }),
    getVersionInfo: () => ({ version: "1.0.0", gitTag: "v1.0.0", gitCommit: "abc123" }),
    latestAlert: () => overrides.latestAlert || null,
    launch: overrides.launch || (() => "spawn"),
    recordAlert: (alert) => alerts.push(alert),
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail })
  });
  return { alerts, audits, checks, env, handlers };
}

describe("self update route helpers", () => {
  it("validates explicit update tags", () => {
    assert.equal(validUpdateTag(""), true);
    assert.equal(validUpdateTag("v1.2.3"), true);
    assert.equal(validUpdateTag("1.2.3-beta.1"), true);
    assert.equal(validUpdateTag("not-a-tag; rm -rf /"), false);
  });

  it("builds updater environment without leaking unrelated process env", () => {
    const env = baseEnv({ updateNotifyWebhook: "https://hook.test" });
    assert.deepEqual(buildUpdaterEnv(env, {
      processEnv: { PATH: "/bin", RUNYARD_UNITS: "runyard.service" },
      nodePath: "/usr/bin/node"
    }), {
      PATH: "/bin",
      RUNYARD_UPDATE_TRIGGER: "http",
      RUNYARD_REPO_DIR: "/srv/runyard",
      RUNYARD_NODE: "/usr/bin/node",
      RUNYARD_DRAIN_GRACE_MS: "1234",
      RUNYARD_HUB_DATA_DIR: "/var/lib/runyard",
      PORT: "7331",
      RUNYARD_UNITS: "runyard.service",
      UPDATE_NOTIFY_WEBHOOK: "https://hook.test"
    });
  });

  it("launches through systemd-run when available and falls back to detached bash", () => {
    const systemdSpawns = [];
    const systemdLauncher = launchUpdater({
      env: baseEnv(),
      script: "/srv/runyard/scripts/runyard-update.sh",
      targetTag: "v2.0.0",
      processEnv: { PATH: "/bin" },
      nodePath: "/node",
      execFile: () => {},
      spawnProcess: (command, args, options) => {
        systemdSpawns.push({ command, args, options });
        return { unref() {} };
      },
      now: () => 42
    });
    assert.equal(systemdLauncher, "systemd-run");
    assert.equal(systemdSpawns[0].command, "systemd-run");
    assert.ok(systemdSpawns[0].args.includes("--unit=runyard-update-42"));
    assert.equal(systemdSpawns[0].args.at(-1), "v2.0.0");

    const bashSpawns = [];
    const bashLauncher = launchUpdater({
      env: baseEnv(),
      script: "/srv/runyard/scripts/runyard-update.sh",
      processEnv: { PATH: "/bin" },
      nodePath: "/node",
      execFile: () => { throw new Error("missing"); },
      spawnProcess: (command, args, options) => {
        bashSpawns.push({ command, args, options });
        return { unref() {} };
      }
    });
    assert.equal(bashLauncher, "spawn");
    assert.equal(bashSpawns[0].command, "bash");
    assert.deepEqual(bashSpawns[0].args, ["/srv/runyard/scripts/runyard-update.sh"]);
    assert.equal(bashSpawns[0].options.cwd, "/srv/runyard");
    assert.equal(bashSpawns[0].options.detached, true);
  });

  it("preflights HTTP-triggered update applies", () => {
    const disabled = updateApplyPreflight({ env: baseEnv(), exists: () => true });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.status, 503);
    assert.equal(disabled.body.applyEnabled, false);

    const invalid = updateApplyPreflight({
      body: { tag: "bad;tag" },
      env: baseEnv({ updateApplyEnabled: true }),
      exists: () => true
    });
    assert.deepEqual(invalid, { ok: false, status: 400, body: { error: "invalid target tag" } });

    const missing = updateApplyPreflight({
      body: { tag: "v2.0.0" },
      env: baseEnv({ updateApplyEnabled: true }),
      exists: () => false
    });
    assert.deepEqual(missing, {
      ok: false,
      status: 500,
      body: { error: "update script not found on this install" }
    });

    const ready = updateApplyPreflight({
      body: { tag: " v2.0.0 " },
      env: baseEnv({ updateApplyEnabled: true }),
      exists: () => true
    });
    assert.deepEqual(ready, {
      ok: true,
      script: updateScriptPath("/srv/runyard"),
      target: "v2.0.0",
      targetTag: "v2.0.0"
    });
  });

  it("returns update status from the current checker", async () => {
    const { checks, handlers } = harness({ latestAlert: { level: "error", message: "failed" } });
    const res = response();

    await handlers.status(req({ query: { refresh: "1" } }), res);

    assert.deepEqual(checks, [true]);
    assert.equal(res.body.current, "1.0.0");
    assert.equal(res.body.latest, "9.9.9");
    assert.equal(res.body.latestTag, "v9.9.9");
    assert.equal(res.body.updateAvailable, true);
    assert.equal(res.body.lastOutcome.level, "error");
  });

  it("keeps apply disabled by default and validates tags before script lookup", () => {
    const disabled = harness();
    const disabledRes = response();
    disabled.handlers.apply(req(), disabledRes);
    assert.equal(disabledRes.statusCode, 503);
    assert.equal(disabledRes.body.applyEnabled, false);

    const invalid = harness({ env: { updateApplyEnabled: true } });
    const invalidRes = response();
    invalid.handlers.apply(req({ body: { tag: "bad;tag" } }), invalidRes);
    assert.equal(invalidRes.statusCode, 400);
  });

  it("records audit and alert before launching a valid update", () => {
    const launched = [];
    const { alerts, audits, handlers } = harness({
      env: { updateApplyEnabled: true },
      launch: ({ script, targetTag }) => {
        launched.push({ script, targetTag });
        return "spawn";
      }
    });
    const res = response();

    handlers.apply(req({ body: { tag: "v2.0.0" } }), res);

    assert.deepEqual(launched, [{ script: updateScriptPath("/srv/runyard"), targetTag: "v2.0.0" }]);
    assert.deepEqual(audits[0], { actor: "Admin", action: "update.apply", target: "v2.0.0", detail: { via: "http" } });
    assert.equal(alerts[0].kind, "update");
    assert.equal(res.body.launcher, "spawn");
  });

  it("does not launch when the update script is missing", () => {
    const { handlers } = harness({ env: { updateApplyEnabled: true }, exists: () => false });
    const res = response();

    handlers.apply(req({ body: { tag: "v2.0.0" } }), res);

    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /update script not found/);
  });
});
