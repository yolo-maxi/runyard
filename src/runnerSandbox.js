// Bubblewrap sandbox preset for the runner's launch-only exec-wrapper seam.
//
// RunYard stays unopinionated about isolation: by default the runner executes
// workflows directly on its host. A deployer who wants filesystem isolation per
// run — without hand-writing a long `bwrap …` argv — sets RUNNER_SANDBOX=bubblewrap
// and this module generates a conservative, portable Bubblewrap command. That
// command plugs into the exact same exec-wrapper array the runner already
// prepends to the workflow *launch* only (`smithers up …`); polling and control
// commands (events/inspect/output/cancel) never enter the sandbox — see
// WRAPPED_SUBCOMMANDS in runnerSmithersRuntime.js.
//
// Pure and side-effect free (the generator does not shell out or stat the FS),
// so the runner and tests can import it freely. Whether `bwrap` is actually
// installed is the deployer's concern; RunYard only constructs the argv.
import path from "node:path";
import { parseCommandList, resolveExecWrapper } from "./resolveSmithersBin.js";

const BUBBLEWRAP_SELECTORS = new Set(["bubblewrap", "bwrap"]);
// Values of RUNNER_SANDBOX that mean "no preset" (run on the host).
const SANDBOX_OFF = new Set(["", "none", "host", "off", "0", "false"]);
// Falsey values for the boolean network toggle.
const FALSEY = new Set(["0", "false", "off", "no"]);

// System directories bound read-only so the engine + toolchain resolve inside
// the sandbox. `--ro-bind-try` skips a missing source, which keeps the preset
// portable across merged-usr (/bin -> /usr/bin) and non-merged layouts.
const SYSTEM_RO_BINDS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

function isFalsey(raw) {
  return FALSEY.has(String(raw ?? "").trim().toLowerCase());
}

// Build the Bubblewrap argv that wraps a workflow launch. The workspace is the
// only writable mount and is bound at the SAME path inside the sandbox, so the
// absolute workflow path the runner passes (`smithers up /ws/workflow.tsx`)
// resolves identically inside and out.
export function bubblewrapArgv({
  workspace,
  smithersBin = "smithers",
  bwrapBin = "bwrap",
  shareNet = true,
  roBinds = []
} = {}) {
  if (!workspace || !path.isAbsolute(workspace)) {
    throw new Error(`bubblewrapArgv requires an absolute workspace path, got: ${JSON.stringify(workspace)}`);
  }
  const argv = [
    bwrapBin,
    // Tie the sandbox lifetime to the runner and give it fresh namespaces. The
    // launch is detached (`smithers up -d`), so the engine daemonizes inside;
    // --die-with-parent ensures an orphaned sandbox can't outlive the runner.
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp"
  ];
  for (const dir of SYSTEM_RO_BINDS) argv.push("--ro-bind-try", dir, dir);
  // Network is SHARED by default: the workflow's agent must reach the Hub and
  // model providers. This first preset isolates the filesystem, not the network.
  if (!shareNet) argv.push("--unshare-net");
  // When the engine resolves to an absolute path outside the system dirs
  // (e.g. ~/.bun/bin/smithers), bind its directory read-only so it is runnable.
  if (smithersBin && path.isAbsolute(smithersBin)) {
    const binDir = path.dirname(smithersBin);
    if (!SYSTEM_RO_BINDS.includes(binDir)) argv.push("--ro-bind-try", binDir, binDir);
  }
  // Operator-supplied extra read-only binds (custom toolchain, $HOME caches the
  // engine needs). Each is an absolute path bound at itself.
  for (const p of roBinds) {
    if (path.isAbsolute(p)) argv.push("--ro-bind-try", p, p);
  }
  // Writable workspace last so it wins any overlap, then chdir into it.
  argv.push("--bind", workspace, workspace, "--chdir", workspace);
  return argv;
}

// Resolve the sandbox preset selected by RUNNER_SANDBOX. Returns [] when no
// preset is selected (sandbox off). Throws on an unknown preset name so a typo
// fails loud at startup rather than silently running unsandboxed.
export function resolveSandboxWrapper({ env = process.env, workspace, smithersBin } = {}) {
  const kind = String(env.RUNNER_SANDBOX ?? "").trim().toLowerCase();
  if (SANDBOX_OFF.has(kind)) return [];
  if (!BUBBLEWRAP_SELECTORS.has(kind)) {
    throw new Error(`unknown RUNNER_SANDBOX preset: "${kind}" (supported: bubblewrap)`);
  }
  return bubblewrapArgv({
    workspace,
    smithersBin,
    bwrapBin: (env.RUNNER_SANDBOX_BWRAP || "").trim() || "bwrap",
    shareNet: !isFalsey(env.RUNNER_SANDBOX_NETWORK ?? ""), // unset => shared
    roBinds: parseCommandList(env.RUNNER_SANDBOX_RO_BIND || "")
  });
}

// Single entry point the runner uses to resolve its launch exec-wrapper. The
// RUNNER_SANDBOX preset takes precedence; when no preset is selected it falls
// back to a literal RUNNER_EXEC_WRAPPER (the unopinionated escape hatch).
export function resolveRunnerExecWrapper({ env = process.env, workspace, smithersBin } = {}) {
  const preset = resolveSandboxWrapper({ env, workspace, smithersBin });
  if (preset.length) return preset;
  return resolveExecWrapper(env);
}
