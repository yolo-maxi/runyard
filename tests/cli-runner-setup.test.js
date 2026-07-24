import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AGENTS_TS_BACKUP_SUFFIX,
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

  // Transactional agents.ts preservation across `smithers init` — real
  // filesystem, byte-for-byte assertions. Smithers ≥0.27 init regenerates
  // .smithers/agents.ts on every run (the only pack file it clobbers,
  // verified on 0.30), so setup must carry the operator's copy across init
  // unchanged, init success or failure, and leave no backup/partial state.
  describe("agents.ts preservation across init", () => {
    // Non-UTF8 byte included on purpose: preservation must be binary-safe,
    // not a decode/encode round-trip.
    const CUSTOM = Buffer.concat([
      Buffer.from("// operator-customized providers\nexport const providers = { claude: 1 };\n"),
      Buffer.from([0xff, 0x00, 0x9c]),
      Buffer.from("\n")
    ]);
    const GENERATED = Buffer.from("// smithers-source: generated\nexport const providers = {};\n");

    function tempWorkspace({ withAgents = true } = {}) {
      const ws = mkdtempSync(path.join(os.tmpdir(), "runyard-setup-agents-"));
      mkdirSync(path.join(ws, ".smithers"), { recursive: true });
      if (withAgents) writeFileSync(path.join(ws, ".smithers", "agents.ts"), CUSTOM);
      return {
        ws,
        agentsPath: path.join(ws, ".smithers", "agents.ts"),
        backupPath: path.join(ws, ".smithers", `agents.ts${AGENTS_TS_BACKUP_SUFFIX}`),
        cleanup: () => rmSync(ws, { recursive: true, force: true })
      };
    }

    // A spawnSync stub acting like 0.30 init: rewrites agents.ts, then
    // reports the given exit status. --version probes report 0.30.0.
    function initStub({ status = 0, rewrite = GENERATED } = {}) {
      return (cmd, args, opts) => {
        if (args[0] === "init") {
          const agents = path.join(opts.cwd, ".smithers", "agents.ts");
          if (rewrite === null) rmSync(agents, { force: true });
          else writeFileSync(agents, rewrite);
          return { status };
        }
        return { status: 0, stdout: "0.30.0\n" };
      };
    }

    const opts = (extra) => ({
      commandExistsFn: () => true,
      templateRoot: "/nonexistent-template-root",
      log: () => {},
      warn: () => {},
      error: () => {},
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
      ...extra
    });

    it("preserves a customized agents.ts byte-for-byte across a clobbering init, leaving no backup", () => {
      const t = tempWorkspace();
      try {
        const result = setupRunnerWorkspace({ workspace: t.ws }, opts({ spawnSyncFn: initStub() }));
        assert.equal(result.ok, true);
        assert.deepEqual(readFileSync(t.agentsPath), CUSTOM, "agents.ts must be byte-identical to the pre-init original");
        assert.equal(existsSync(t.backupPath), false, "no backup file may remain after a successful setup");
      } finally {
        t.cleanup();
      }
    });

    it("restores agents.ts and removes the backup even when init FAILS", () => {
      const t = tempWorkspace();
      try {
        assert.throws(
          () => setupRunnerWorkspace({ workspace: t.ws }, opts({ spawnSyncFn: initStub({ status: 1 }) })),
          /exit 1/
        );
        assert.deepEqual(readFileSync(t.agentsPath), CUSTOM, "a failed init must not leave the regenerated copy behind");
        assert.equal(existsSync(t.backupPath), false, "no backup file may remain after a failed setup");
      } finally {
        t.cleanup();
      }
    });

    it("restores agents.ts when init deletes it outright", () => {
      const t = tempWorkspace();
      try {
        setupRunnerWorkspace({ workspace: t.ws }, opts({ spawnSyncFn: initStub({ rewrite: null }) }));
        assert.deepEqual(readFileSync(t.agentsPath), CUSTOM);
        assert.equal(existsSync(t.backupPath), false);
      } finally {
        t.cleanup();
      }
    });

    it("keeps init's generated agents.ts on a fresh workspace (nothing to preserve, no backup created)", () => {
      const t = tempWorkspace({ withAgents: false });
      const backupsSeen = [];
      try {
        setupRunnerWorkspace(
          { workspace: t.ws },
          opts({
            spawnSyncFn: initStub(),
            writeFileSyncFn: (file, data) => {
              if (String(file).endsWith(AGENTS_TS_BACKUP_SUFFIX)) backupsSeen.push(file);
              return writeFileSync(file, data);
            }
          })
        );
        assert.deepEqual(readFileSync(t.agentsPath), GENERATED, "fresh workspaces adopt the generated agents.ts");
        assert.equal(existsSync(t.backupPath), false);
        assert.equal(backupsSeen.length, 0, "no backup is ever written when there is nothing to preserve");
      } finally {
        t.cleanup();
      }
    });

    it("recovers from a crashed previous setup: leftover backup wins over the clobbered file", () => {
      const t = tempWorkspace();
      const warnings = output();
      try {
        // Simulate a setup that died between init and restore: agents.ts holds
        // init's regenerated copy, the backup still holds the operator's bytes.
        writeFileSync(t.agentsPath, GENERATED);
        writeFileSync(t.backupPath, CUSTOM);
        setupRunnerWorkspace({ workspace: t.ws }, opts({ spawnSyncFn: initStub(), warn: warnings.write }));
        assert.deepEqual(readFileSync(t.agentsPath), CUSTOM, "the interrupted-setup backup must be restored");
        assert.equal(existsSync(t.backupPath), false, "recovery must not leave the stale backup behind");
        assert.ok(warnings.lines.some((line) => line.includes("previous setup was interrupted")));
      } finally {
        t.cleanup();
      }
    });
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
