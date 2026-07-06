import { cpSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_TEMPLATE_INCLUDE_PATHS } from "./workflowTemplateIncludes.js";

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
  const init = spawnSyncFn("smithers", ["init"], { cwd: ws, stdio: "inherit" });
  if (init.status !== 0) {
    error("`smithers init` failed.");
    exit(1);
    return { ok: false, reason: "smithers-init-failed", workspace: ws };
  }

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
