import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  commandExists,
  runnerPrerequisiteSummary,
  setupRunnerWorkspace
} from "../src/cliRunnerSetup.js";
import { WORKFLOW_TEMPLATE_INCLUDE_PATHS } from "../src/workflowTemplateIncludes.js";

function output() {
  const lines = [];
  return {
    lines,
    write: (...args) => lines.push(args.join(" "))
  };
}

describe("CLI runner setup helpers", () => {
  it("checks commands through /usr/bin/env sh", () => {
    const calls = [];
    const found = commandExists("bun", {
      spawnSyncFn: (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 0 };
      }
    });

    assert.equal(found, true);
    assert.deepEqual(calls, [{
      cmd: "/usr/bin/env",
      args: ["sh", "-c", "command -v bun >/dev/null 2>&1"]
    }]);
  });

  it("summarizes prerequisites with stable labels", () => {
    assert.equal(
      runnerPrerequisiteSummary(["node", "bun"], (cmd) => cmd === "node"),
      "node:ok  bun:—"
    );
  });

  it("exits with install instructions when required engine commands are missing", () => {
    const errors = output();
    assert.throws(
      () => setupRunnerWorkspace(
        { workspace: "/tmp/runyard", location: "local" },
        {
          commandExistsFn: (cmd) => cmd === "node",
          log: () => {},
          error: errors.write,
          exit: (code) => {
            throw new Error(`exit ${code}`);
          }
        }
      ),
      /exit 1/
    );

    assert.ok(errors.lines.some((line) => line.includes("Install the Smithers engine first")));
    assert.ok(errors.lines.some((line) => line.includes("bun add -g smithers-orchestrator")));
  });

  it("warns when no agent CLI is installed but the Smithers engine is present", () => {
    const warnings = output();
    const result = setupRunnerWorkspace(
      { workspace: "/tmp/runyard", location: "vps" },
      {
        commandExistsFn: (cmd) => ["node", "bun", "smithers"].includes(cmd),
        mkdirSyncFn: () => {},
        spawnSyncFn: () => ({ status: 0 }),
        existsSyncFn: () => false,
        log: () => {},
        warn: warnings.write
      }
    );

    assert.equal(result.ok, true);
    assert.ok(warnings.lines[0].includes("no 'claude', 'codex', or 'pi' CLI"));
  });

  it("scaffolds the workspace and overlays bundled templates", () => {
    const mkdirs = [];
    const spawns = [];
    const copies = [];
    const logs = output();
    const workspace = path.resolve("tmp-runyard-workspace");
    const templateRoot = "/repo/workflow-templates";

    const result = setupRunnerWorkspace(
      { workspace, location: "local" },
      {
        commandExistsFn: () => true,
        mkdirSyncFn: (...args) => mkdirs.push(args),
        spawnSyncFn: (...args) => {
          spawns.push(args);
          return { status: 0, stdout: "0.30.0\n" };
        },
        existsSyncFn: (file) => file === templateRoot || WORKFLOW_TEMPLATE_INCLUDE_PATHS.some((relative) => file === path.join("/repo", relative)),
        cpSyncFn: (...args) => copies.push(args),
        templateRoot,
        log: logs.write
      }
    );

    assert.deepEqual(result, { ok: true, workspace });
    assert.deepEqual(mkdirs[0], [workspace, { recursive: true }]);
    // 0.27+ init is interactive by default — the setup flow must run it
    // non-interactively, then report the version the workspace pack pins
    // (project-local delegation makes that the engine that actually runs).
    assert.deepEqual(spawns[0], ["smithers", ["init", "--yes", "--non-interactive"], { cwd: workspace, stdio: "inherit" }]);
    assert.deepEqual(spawns[1], ["smithers", ["--version"], { cwd: workspace, encoding: "utf8" }]);
    assert.ok(logs.lines.some((line) => line.includes("Effective smithers engine in this workspace: 0.30.0")));
    assert.deepEqual(copies, WORKFLOW_TEMPLATE_INCLUDE_PATHS.map((relative) => [
      path.join("/repo", relative),
      path.join(workspace, relative.replace(/^workflow-templates\//, ".smithers/"))
    ]));
    assert.ok(logs.lines.some((line) => line.includes("Added release-candidate workflow templates")));
    assert.ok(logs.lines.some((line) => line.includes(`runyard runner start --workspace ${workspace} --location local`)));
  });

  it("exits when smithers init fails", () => {
    const errors = output();
    assert.throws(
      () => setupRunnerWorkspace(
        { workspace: "/tmp/runyard", location: "local" },
        {
          commandExistsFn: () => true,
          mkdirSyncFn: () => {},
          spawnSyncFn: () => ({ status: 1 }),
          log: () => {},
          error: errors.write,
          exit: (code) => {
            throw new Error(`exit ${code}`);
          }
        }
      ),
      /exit 1/
    );

    assert.ok(errors.lines.includes("`smithers init` failed."));
  });
});
