import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import {
  bubblewrapArgv,
  resolveSandboxWrapper,
  resolveRunnerExecWrapper
} from "../src/runnerSandbox.js";
import { smithersCommand } from "../src/runnerSmithersRuntime.js";

const WS = "/srv/runner/workspace";

describe("bubblewrapArgv", () => {
  it("binds system dirs read-only and the workspace read-write at the same path", () => {
    const argv = bubblewrapArgv({ workspace: WS });
    assert.equal(argv[0], "bwrap");
    // Workspace is the sole writable mount, bound at the same path, then chdir'd.
    assert.deepEqual(argv.slice(-5), ["--bind", WS, WS, "--chdir", WS]);
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
      assert.deepEqual(argv.slice(-5), ["--bind", WS, WS, "--chdir", WS]);
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
