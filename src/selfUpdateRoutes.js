import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { actorName } from "./routeActors.js";

export function validUpdateTag(tag = "") {
  return !tag || /^v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(tag);
}

export function updateScriptPath(root) {
  return path.join(root, "scripts", "runyard-update.sh");
}

export function buildUpdaterEnv(env, { processEnv = process.env, nodePath = process.execPath } = {}) {
  const updaterEnv = {
    PATH: processEnv.PATH || "",
    RUNYARD_UPDATE_TRIGGER: "http",
    RUNYARD_REPO_DIR: env.root,
    RUNYARD_NODE: nodePath,
    RUNYARD_DRAIN_GRACE_MS: String(env.drainGraceMs),
    RUNYARD_HUB_DATA_DIR: env.dataDir,
    PORT: String(env.port)
  };
  if (processEnv.RUNYARD_UNITS) updaterEnv.RUNYARD_UNITS = processEnv.RUNYARD_UNITS;
  if (env.updateNotifyWebhook) updaterEnv.UPDATE_NOTIFY_WEBHOOK = env.updateNotifyWebhook;
  return updaterEnv;
}

export function systemdRunAvailable(execFile = execFileSync) {
  try {
    execFile("systemd-run", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function launchUpdater({
  env,
  script,
  targetTag = "",
  processEnv = process.env,
  nodePath = process.execPath,
  execFile = execFileSync,
  spawnProcess = spawn,
  now = Date.now
} = {}) {
  const updaterEnv = buildUpdaterEnv(env, { processEnv, nodePath });
  if (systemdRunAvailable(execFile)) {
    const unit = `runyard-update-${now()}`;
    const setenv = Object.entries(updaterEnv).flatMap(([key, value]) => ["--setenv", `${key}=${value}`]);
    const args = ["--collect", "--quiet", `--unit=${unit}`, ...setenv, "bash", script];
    if (targetTag) args.push(targetTag);
    spawnProcess("systemd-run", args, { stdio: "ignore", detached: true }).unref();
    return "systemd-run";
  }

  const args = [script];
  if (targetTag) args.push(targetTag);
  spawnProcess("bash", args, {
    cwd: env.root,
    detached: true,
    stdio: "ignore",
    env: { ...processEnv, ...updaterEnv }
  }).unref();
  return "spawn";
}

export function updateApplyPreflight({ body = {}, env, exists = existsSync } = {}) {
  if (!env.updateApplyEnabled) {
    return {
      ok: false,
      status: 503,
      body: {
        error:
          "HTTP-triggered update is disabled. Run `runyard update` on the host, or set UPDATE_APPLY_ENABLED=1 to enable this button.",
        applyEnabled: false
      }
    };
  }

  const targetTag = typeof body?.tag === "string" ? body.tag.trim() : "";
  if (!validUpdateTag(targetTag)) return { ok: false, status: 400, body: { error: "invalid target tag" } };

  const script = updateScriptPath(env.root);
  if (!exists(script)) return { ok: false, status: 500, body: { error: "update script not found on this install" } };

  return {
    ok: true,
    script,
    target: targetTag || "latest",
    targetTag
  };
}

export function createUpdateHandlers({
  env,
  exists = existsSync,
  getUpdateChecker,
  getVersionInfo,
  latestAlert,
  launch = launchUpdater,
  recordAlert,
  recordAudit
} = {}) {
  return {
    async status(req, res) {
      const checker = getUpdateChecker();
      if (req.query.refresh && env.updateCheckEnabled) {
        try {
          await checker.check(true);
        } catch {
          /* check() is already fail-safe; ignore */
        }
      }
      const info = getVersionInfo();
      const cached = checker.getCached();
      res.json({
        current: info.version,
        gitTag: info.gitTag,
        gitCommit: info.gitCommit,
        repo: env.githubRepo,
        enabled: env.updateCheckEnabled,
        applyEnabled: env.updateApplyEnabled,
        latest: cached?.latest || null,
        latestTag: cached?.latestTag || (cached?.latest ? `v${cached.latest}` : null),
        updateAvailable: Boolean(cached?.updateAvailable),
        status: cached?.status || (env.updateCheckEnabled ? "pending" : "disabled"),
        checkedAt: cached?.checkedAt ? new Date(cached.checkedAt).toISOString() : null,
        lastOutcome: latestAlert("update")
      });
    },

    apply(req, res) {
      const preflight = updateApplyPreflight({ body: req.body, env, exists });
      if (!preflight.ok) return res.status(preflight.status).json(preflight.body);
      const actor = actorName(req.token);
      recordAudit(actor, "update.apply", preflight.target, { via: "http" });
      recordAlert({
        kind: "update",
        level: "info",
        title: "Update started",
        message: `${actor} triggered an update to ${preflight.target} from the Hub UI.`,
        data: { targetTag: preflight.target, by: actor, via: "http" }
      });

      try {
        const launcher = launch({ env, script: preflight.script, targetTag: preflight.targetTag });
        res.json({ started: true, target: preflight.target, launcher });
      } catch (error) {
        res.status(500).json({ error: `could not start updater: ${error.message}` });
      }
    }
  };
}
