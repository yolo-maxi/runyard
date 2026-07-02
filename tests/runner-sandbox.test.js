import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import {
  bubblewrapArgv,
  resolveSandboxWrapper,
  resolveRunnerExecWrapper,
  SANDBOX_HOME_SUBDIR
} from "../src/runnerSandbox.js";
import { smithersCommand } from "../src/runnerSmithersRuntime.js";

const WS = "/srv/runner/workspace";

// Index of the token that follows the first `flag value` pair matching `flag`.
function valueAfter(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

describe("bubblewrapArgv", () => {
  it("binds system dirs read-only and the workspace read-write at the same path", () => {
    const argv = bubblewrapArgv({ workspace: WS });
    assert.equal(argv[0], "bwrap");
    // Workspace is the sole writable mount, bound at the same path; the sandbox
    // finishes by chdir'ing into it.
    assert.deepEqual(argv.slice(-2), ["--chdir", WS]);
    assert.deepEqual([valueAfter(argv, "--bind"), argv[argv.indexOf("--bind") + 2]], [WS, WS]);
    // System dirs are read-only via -try (portable across merged-usr layouts).
    assert.ok(argv.includes("--ro-bind-try"));
    for (const dir of ["/usr", "/etc", "/lib"]) {
      const i = argv.indexOf(dir);
      assert.ok(i > 0 && argv[i - 1] === "--ro-bind-try", `${dir} should be ro-bind-try`);
    }
    // No writable bind other than the workspace.
    const bindIdxs = argv.reduce((acc, tok, i) => (tok === "--bind" ? [...acc, i] : acc), []);
    assert.deepEqual(bindIdxs.map((i) => argv[i + 1]), [WS]);
  });

  it("shares the network by default and unshares it only when asked", () => {
    assert.ok(!bubblewrapArgv({ workspace: WS }).includes("--unshare-net"));
    assert.ok(bubblewrapArgv({ workspace: WS, shareNet: false }).includes("--unshare-net"));
  });

  it("binds the engine's directory when it lives outside the system dirs", () => {
    const argv = bubblewrapArgv({ workspace: WS, smithersBin: "/home/runner/.bun/bin/smithers" });
    const i = argv.indexOf("/home/runner/.bun/bin");
    assert.ok(i > 0 && argv[i - 1] === "--ro-bind-try");
    // A bare (PATH-resolved) binary adds no extra bind.
    assert.ok(!bubblewrapArgv({ workspace: WS, smithersBin: "smithers" }).includes("--ro-bind-try/home"));
  });

  it("adds operator-supplied read-only binds and honours a custom bwrap path", () => {
    const argv = bubblewrapArgv({
      workspace: WS,
      bwrapBin: "/usr/bin/bwrap",
      roBinds: ["/opt/toolchain", "relative/skip"]
    });
    assert.equal(argv[0], "/usr/bin/bwrap");
    const i = argv.indexOf("/opt/toolchain");
    assert.ok(i > 0 && argv[i - 1] === "--ro-bind-try");
    // Relative binds are ignored (bwrap needs absolute source paths).
    assert.ok(!argv.includes("relative/skip"));
  });

  it("rejects a missing or relative workspace", () => {
    assert.throws(() => bubblewrapArgv({ workspace: "" }), /absolute workspace/);
    assert.throws(() => bubblewrapArgv({ workspace: "relative/ws" }), /absolute workspace/);
  });

  it("gives the child a writable HOME under the workspace and walls off the host HOME", () => {
    const argv = bubblewrapArgv({ workspace: WS });
    const homeDir = `${WS}/${SANDBOX_HOME_SUBDIR}`;
    // HOME is repointed into the workspace...
    assert.equal(valueAfter(argv, "--setenv"), "HOME");
    assert.equal(argv[argv.indexOf("--setenv") + 2], homeDir);
    // ...and materialized so it exists before the engine writes to it.
    assert.equal(valueAfter(argv, "--dir"), homeDir);
    // The HOME dir is created AFTER the workspace is bound rw (order matters:
    // --dir lands inside the bind, not on an empty sandbox root).
    assert.ok(argv.lastIndexOf("--bind") < argv.indexOf("--dir"), "--dir must follow the workspace --bind");
    // The runner host HOME is never bound in.
    assert.ok(!argv.includes(os.homedir()) || os.homedir() === WS, "host HOME must not be a mount source");
  });

  it("clears host XDG_* so config/cache/data re-derive from the sandbox HOME", () => {
    const argv = bubblewrapArgv({ workspace: WS });
    for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
      const i = argv.indexOf(key);
      assert.ok(i > 0 && argv[i - 1] === "--unsetenv", `${key} should be --unsetenv'd`);
    }
  });

  it("keeps the writable HOME inside the workspace regardless of workspace path", () => {
    const argv = bubblewrapArgv({ workspace: "/data/runs/ws-42" });
    assert.equal(valueAfter(argv, "--setenv"), "HOME");
    assert.equal(argv[argv.indexOf("--setenv") + 2], "/data/runs/ws-42/.home");
  });
});

describe("resolveSandboxWrapper", () => {
  it("returns [] when no preset is selected", () => {
    for (const RUNNER_SANDBOX of [undefined, "", "none", "host", "off"]) {
      assert.deepEqual(resolveSandboxWrapper({ env: { RUNNER_SANDBOX }, workspace: WS }), []);
    }
  });

  it("builds a bwrap argv for bubblewrap/bwrap selectors", () => {
    for (const RUNNER_SANDBOX of ["bubblewrap", "bwrap", "BubbleWrap"]) {
      const argv = resolveSandboxWrapper({ env: { RUNNER_SANDBOX }, workspace: WS });
      assert.equal(argv[0], "bwrap");
      assert.deepEqual(argv.slice(-2), ["--chdir", WS]);
    }
  });

  it("threads env knobs (bwrap path, network off, extra binds) into the argv", () => {
    const argv = resolveSandboxWrapper({
      env: {
        RUNNER_SANDBOX: "bubblewrap",
        RUNNER_SANDBOX_BWRAP: "/opt/bwrap",
        RUNNER_SANDBOX_NETWORK: "0",
        RUNNER_SANDBOX_RO_BIND: '["/opt/a","/opt/b"]'
      },
      workspace: WS
    });
    assert.equal(argv[0], "/opt/bwrap");
    assert.ok(argv.includes("--unshare-net"));
    assert.ok(argv.includes("/opt/a") && argv.includes("/opt/b"));
  });

  it("throws loud on an unknown preset name (fails closed, not silently unsandboxed)", () => {
    assert.throws(
      () => resolveSandboxWrapper({ env: { RUNNER_SANDBOX: "firejail" }, workspace: WS }),
      /unknown RUNNER_SANDBOX preset/
    );
  });
});

describe("resolveRunnerExecWrapper (preset + literal precedence)", () => {
  it("prefers the sandbox preset over a literal exec wrapper", () => {
    const argv = resolveRunnerExecWrapper({
      env: { RUNNER_SANDBOX: "bubblewrap", RUNNER_EXEC_WRAPPER: "docker run img" },
      workspace: WS
    });
    assert.equal(argv[0], "bwrap");
  });

  it("falls back to the literal exec wrapper when no preset is selected", () => {
    assert.deepEqual(
      resolveRunnerExecWrapper({ env: { RUNNER_EXEC_WRAPPER: "firejail --quiet" }, workspace: WS }),
      ["firejail", "--quiet"]
    );
  });

  it("returns [] (bare host) when neither is set", () => {
    assert.deepEqual(resolveRunnerExecWrapper({ env: {}, workspace: WS }), []);
  });
});

// Real Bubblewrap smoke — only runs where `bwrap` is actually installed AND user
// namespaces work; skipped otherwise (e.g. this dev box, most CI). Proves the
// generated argv delivers a writable HOME inside the workspace while host paths
// stay invisible — i.e. the isolation the unit tests assert structurally.
const HAVE_BWRAP = (() => {
  try {
    execFileSync("bwrap", ["--version"], { stdio: "ignore" });
    // A --version success doesn't guarantee userns is permitted; probe a no-op.
    execFileSync("bwrap", ["--ro-bind", "/usr", "/usr", "--proc", "/proc", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("real bwrap: sandbox HOME is writable and host paths are invisible", { skip: !HAVE_BWRAP && "bwrap unavailable" }, () => {
  const workspace = mkdtempSync(nodePath.join(os.tmpdir(), "runyard-bwrap-ws-"));
  const secretDir = mkdtempSync(nodePath.join(os.tmpdir(), "runyard-host-secret-"));
  const secretFile = nodePath.join(secretDir, "runner-secret");
  writeFileSync(secretFile, "TOP-SECRET-RUNNER-KEY");

  const argv = bubblewrapArgv({ workspace });
  const script = [
    'printf "HOME=%s\\n" "$HOME"',
    'touch "$HOME/canary" && echo WROTE_HOME',
    `cat ${secretFile} 2>/dev/null && echo LEAK || echo NO_LEAK`
  ].join("; ");
  const out = execFileSync(argv[0], [...argv.slice(1), "/bin/sh", "-c", script], { encoding: "utf8" });

  assert.match(out, new RegExp(`HOME=${workspace}/${SANDBOX_HOME_SUBDIR}`), "HOME points into the workspace");
  assert.match(out, /WROTE_HOME/, "HOME is writable");
  assert.match(out, /NO_LEAK/, "host secret outside the workspace is not readable");
  assert.doesNotMatch(out, /TOP-SECRET-RUNNER-KEY/);
  // The canary the sandbox wrote is visible on the host workspace HOME dir.
  assert.equal(
    readFileSync(nodePath.join(workspace, SANDBOX_HOME_SUBDIR, "canary"), "utf8"),
    ""
  );
});

// End-to-end seam proof: the bwrap preset wraps a launch (`up`) but the runner's
// control/polling commands still run the binary directly, even with the sandbox on.
test("bubblewrap preset wraps launch only, control commands stay direct", () => {
  const execWrapper = resolveSandboxWrapper({ env: { RUNNER_SANDBOX: "bubblewrap" }, workspace: WS });
  const smithersBin = "/home/runner/.bun/bin/smithers";

  const launch = smithersCommand({ smithersBin, execWrapper }, ["up", `${WS}/workflow.tsx`, "--input", "-"]);
  assert.equal(launch.cmd, "bwrap");
  // ...<bwrap flags>... <smithersBin> up <workflow> --input -
  assert.deepEqual(launch.args.slice(-5), [smithersBin, "up", `${WS}/workflow.tsx`, "--input", "-"]);

  for (const args of [["events", "run-1"], ["inspect", "run-1"], ["output", "run-1", "n1"], ["cancel", "run-1"]]) {
    assert.deepEqual(
      smithersCommand({ smithersBin, execWrapper }, args),
      { cmd: smithersBin, args },
      `${args[0]} must run directly, outside the sandbox`
    );
  }
});
