import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  commandExists,
  runnerPrerequisiteSummary,
  setupRunnerWorkspace
} from "../src/cliRunnerSetup.js";

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
          return { status: 0 };
        },
        existsSyncFn: (file) => file === templateRoot,
        cpSyncFn: (...args) => copies.push(args),
        templateRoot,
        log: logs.write
      }
    );

    assert.deepEqual(result, { ok: true, workspace });
    assert.deepEqual(mkdirs, [[workspace, { recursive: true }]]);
    assert.deepEqual(spawns, [["smithers", ["init"], { cwd: workspace, stdio: "inherit" }]]);
    assert.deepEqual(copies, [
      [path.join(templateRoot, "workflows"), path.join(workspace, ".smithers", "workflows"), { recursive: true }],
      [path.join(templateRoot, "examples"), path.join(workspace, ".smithers", "examples"), { recursive: true }]
    ]);
    assert.ok(logs.lines.some((line) => line.includes("Added Hub workflow templates")));
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
