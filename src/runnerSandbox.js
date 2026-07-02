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

// The launched workflow gets a writable HOME here, a dotdir under its own
// workspace. The runner host's real HOME (operator SSH keys, ~/.config creds,
// the runner's own secrets) is never mounted; this replaces it with fresh,
// isolated, workspace-local storage. Shared per-workspace across a runner's
// concurrent runs, never exposed to the host.
export const SANDBOX_HOME_SUBDIR = ".home";

// Host XDG base-dir vars are cleared inside the sandbox: on the host they point
// at the (unmounted) host HOME, so leaving them set would send config/cache/data
// writes at dead paths. Cleared, tools re-derive them from the sandbox HOME
// per the XDG spec ($HOME/.config, $HOME/.cache, $HOME/.local/share).
const SANDBOX_UNSET_ENV = ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"];

function isFalsey(raw) {
  return FALSEY.has(String(raw ?? "").trim().toLowerCase());
}

// Build the Bubblewrap argv that wraps a workflow launch. The workspace is the
// only writable mount and is bound at the SAME path inside the sandbox, so the
// absolute workflow path the runner passes (`smithers up /ws/workflow.tsx`)
// resolves identically inside and out. The child also gets a writable HOME
// (a dotdir under the workspace) with the host HOME/XDG dirs walled off — see
// SANDBOX_HOME_SUBDIR.
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
    // Explicit user namespace with a deterministic single-uid mapping. Being
    // unprivileged and non-setuid, bwrap needs a user namespace to gain the caps
    // for its mounts; requesting it explicitly (rather than relying on the
    // implicit default) and pinning the child to uid/gid 0 *inside* the namespace
    // gives a stable, single-entry uid_map — which is what kernels that only
    // permit a lone identity mapping will accept. Root here is confined to the
    // namespace and maps back to the runner's unprivileged uid on the host, so
    // files land with the runner's ownership. NOTE: this does not bypass an LSM
    // that forbids unprivileged userns outright (e.g. Ubuntu's
    // kernel.apparmor_restrict_unprivileged_userns=1) — that stays a host-config
    // prerequisite for RUNNER_SANDBOX=bubblewrap.
    "--unshare-user",
    "--uid", "0",
    "--gid", "0",
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
  // Operator-supplied extra read-only binds (custom toolchain, shared runtime
  // dirs the engine needs). Each is an absolute path bound at itself. (The
  // workflow's writable HOME is provided below, not via these.)
  for (const p of roBinds) {
    if (path.isAbsolute(p)) argv.push("--ro-bind-try", p, p);
  }
  // Writable workspace last so it wins any overlap. Then carve a writable HOME
  // out of it (--dir materializes the dotdir inside the just-bound workspace),
  // repoint HOME there, and clear the host XDG_* that pointed at the unmounted
  // host HOME. This is the whole "sane writable HOME/cache" story: the child can
  // write ~/.cache, ~/.config, etc. without ever touching — or exposing — the
  // runner host's home. Finally chdir into the workspace.
  const homeDir = path.join(workspace, SANDBOX_HOME_SUBDIR);
  argv.push("--bind", workspace, workspace, "--dir", homeDir, "--setenv", "HOME", homeDir);
  for (const key of SANDBOX_UNSET_ENV) argv.push("--unsetenv", key);
  argv.push("--chdir", workspace);
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

// True when `execWrapper` is this module's Bubblewrap preset (as opposed to an
// empty/bare host or a literal RUNNER_EXEC_WRAPPER). Keys off the explicit
// user-namespace unshare the preset always emits and no literal wrapper would.
export function isBubblewrapWrapper(execWrapper = []) {
  return execWrapper.includes("--unshare-user") && execWrapper.includes("--uid");
}

// One-line, actionable remediation for the failure operators hit when they
// select the Bubblewrap sandbox on a host that forbids unprivileged user
// namespaces (Ubuntu's `setting up uid map: Permission denied`). Kept here, and
// unit-tested, so the runner's startup preflight and docs stay in sync.
export function usernsRemediation() {
  return (
    "RUNNER_SANDBOX=bubblewrap is set but bwrap cannot create a user namespace " +
    "(unprivileged user namespaces are restricted on this host). Install the " +
    "narrow AppArmor profile with `sudo deploy/apparmor/install.sh`, or set " +
    "`sysctl kernel.apparmor_restrict_unprivileged_userns=0`. Until then every " +
    "workflow launch will fail with 'setting up uid map: Permission denied'."
  );
}

// Single entry point the runner uses to resolve its launch exec-wrapper. The
// RUNNER_SANDBOX preset takes precedence; when no preset is selected it falls
// back to a literal RUNNER_EXEC_WRAPPER (the unopinionated escape hatch).
export function resolveRunnerExecWrapper({ env = process.env, workspace, smithersBin } = {}) {
  const preset = resolveSandboxWrapper({ env, workspace, smithersBin });
  if (preset.length) return preset;
  return resolveExecWrapper(env);
}
