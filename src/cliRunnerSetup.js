import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_TEMPLATE_INCLUDE_PATHS } from "./workflowTemplateIncludes.js";

// Smithers ≥0.27 `init` REWRITES `.smithers/agents.ts` on every invocation
// (verified on 0.30 by checksum; every adjacent pack file — agents/*.ts,
// smithers.config.ts, preload.ts, gateway.ts, bunfig.toml, package.json —
// survives re-init with customizations intact, so agents.ts is the whole
// preserve-set). Setup snapshots it to this sibling path before init and
// restores it byte-for-byte afterwards, init success or failure. The on-disk
// backup only exists between snapshot and restore; a leftover copy means a
// previous setup died mid-flight, and the next setup restores it first.
export const AGENTS_TS_BACKUP_SUFFIX = ".runyard-setup-backup";

export const RUNNER_SETUP_COMMANDS = ["node", "bun", "smithers", "claude", "codex", "pi"];

export function commandExists(cmd, { spawnSyncFn = spawnSync } = {}) {
  return spawnSyncFn("/usr/bin/env", ["sh", "-c", `command -v ${cmd} >/dev/null 2>&1`]).status === 0;
}

export function runnerPrerequisiteSummary(commands = RUNNER_SETUP_COMMANDS, commandExistsFn = commandExists) {
  return commands.map((cmd) => `${cmd}:${commandExistsFn(cmd) ? "ok" : "—"}`).join("  ");
}

export function setupRunnerWorkspace(
  { workspace = process.cwd(), location = "local" } = {},
  {
    commandExistsFn = commandExists,
    mkdirSyncFn = mkdirSync,
    spawnSyncFn = spawnSync,
    existsSyncFn = existsSync,
    cpSyncFn = cpSync,
    readFileSyncFn = readFileSync,
    writeFileSyncFn = writeFileSync,
    rmSyncFn = rmSync,
    templateRoot = fileURLToPath(new URL("../workflow-templates", import.meta.url)),
    log = console.log,
    warn = console.warn,
    error = console.error,
    exit = process.exit
  } = {}
) {
  const ws = path.resolve(workspace);
  const exists = (cmd) => commandExistsFn(cmd);

  log("Prerequisites:", runnerPrerequisiteSummary(RUNNER_SETUP_COMMANDS, exists));
  if (!exists("bun") || !exists("smithers")) {
    error("\nInstall the Smithers engine first, then re-run:");
    error("  curl -fsSL https://bun.sh/install | bash   # if bun is missing");
    error("  bun add -g smithers-orchestrator");
    exit(1);
    return { ok: false, reason: "missing-smithers-engine", workspace: ws };
  }

  if (!exists("claude") && !exists("codex") && !exists("pi")) {
    warn("\nWarning: no 'claude', 'codex', or 'pi' CLI on PATH. Workflows need at least one authed agent CLI.");
  }

  mkdirSyncFn(ws, { recursive: true });
  log(`\nScaffolding Smithers workspace in ${ws} ...`);

  // Transactional preservation of the operator's agent configuration across
  // `smithers init` (see AGENTS_TS_BACKUP_SUFFIX). Sequence: recover any
  // backup a crashed previous setup left behind, snapshot the current file
  // (disk backup + in-memory bytes), run init, restore byte-for-byte whatever
  // init did — including when init FAILS — then drop the backup.
  const agentsPath = path.join(ws, ".smithers", "agents.ts");
  const agentsBackupPath = `${agentsPath}${AGENTS_TS_BACKUP_SUFFIX}`;
  if (existsSyncFn(agentsBackupPath)) {
    warn("Found a leftover agents.ts setup backup (a previous setup was interrupted); restoring it before init.");
    writeFileSyncFn(agentsPath, readFileSyncFn(agentsBackupPath));
    rmSyncFn(agentsBackupPath);
  }
  const preservedAgents = existsSyncFn(agentsPath) ? readFileSyncFn(agentsPath) : null;
  if (preservedAgents !== null) {
    writeFileSyncFn(agentsBackupPath, preservedAgents);
    log("Preserving existing .smithers/agents.ts across init (Smithers ≥0.27 init regenerates it).");
  }

  const init = spawnSyncFn("smithers", ["init", "--yes", "--non-interactive"], { cwd: ws, stdio: "inherit" });

  if (preservedAgents !== null) {
    const initCopy = existsSyncFn(agentsPath) ? readFileSyncFn(agentsPath) : null;
    const initChangedIt = initCopy === null || !preservedAgents.equals(initCopy);
    if (initChangedIt) {
      writeFileSyncFn(agentsPath, preservedAgents);
      log(
        "Restored your customized .smithers/agents.ts (init's regenerated copy was discarded). " +
          "To adopt a freshly generated agents.ts instead, move yours aside and re-run setup."
      );
    }
    rmSyncFn(agentsBackupPath);
  }

  if (init.status !== 0) {
    error("`smithers init` failed.");
    exit(1);
    return { ok: false, reason: "smithers-init-failed", workspace: ws };
  }

  // Since 0.27 the smithers binary delegates to the nearest project-local
  // install — after init that is the workspace pack (.smithers/node_modules),
  // which pins the engine every run in this workspace will actually execute.
  // Report it so version drift is visible at setup time, not mid-run.
  const versionProbe = spawnSyncFn("smithers", ["--version"], { cwd: ws, encoding: "utf8" });
  const effectiveVersion = String(versionProbe?.stdout || "").trim();
  if (effectiveVersion) log(`Effective smithers engine in this workspace: ${effectiveVersion}`);

  if (existsSyncFn(templateRoot)) {
    const appRoot = path.dirname(templateRoot);
    for (const relative of WORKFLOW_TEMPLATE_INCLUDE_PATHS) {
      const source = path.join(appRoot, relative);
      if (!existsSyncFn(source)) continue;
      const target = path.join(ws, relative.replace(/^workflow-templates\//, ".smithers/"));
      mkdirSyncFn(path.dirname(target), { recursive: true });
      cpSyncFn(source, target);
    }
    log("Added release-candidate workflow templates.");
  }

  log(`\n✓ Workspace ready. Start the runner:\n  runyard runner start --workspace ${ws} --location ${location}`);
  return { ok: true, workspace: ws };
}
