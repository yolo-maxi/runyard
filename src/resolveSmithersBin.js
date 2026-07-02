// Deterministically resolve the `smithers` (smithers-orchestrator) executable
// the runner should invoke.
//
// On dstack/containerized deployments the engine is pinned via
// `bun add -g smithers-orchestrator@<PIN>`, which links the binary into
// `$BUN_INSTALL/bin` (default `~/.bun/bin`). A bare `smithers` on PATH would
// otherwise depend on whatever the runtime shell happens to expose, so we prefer
// the pinned install explicitly. Precedence:
//
//   1. SMITHERS_BIN — explicit operator override (trusted as-is when set).
//   2. The bun global-install path ($BUN_INSTALL/bin/smithers, else
//      ~/.bun/bin/smithers) when that file exists.
//   3. `smithers` on PATH — the historical default, kept for single-box
//      installs where bun put smithers on PATH already.
//
// Pure and side-effect free so the runner and tests can import it freely.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveSmithersBin(env = process.env) {
  const explicit = (env.SMITHERS_BIN || "").trim();
  if (explicit) return explicit;

  const bunInstall = (env.BUN_INSTALL || "").trim() || path.join(os.homedir(), ".bun");
  const bunBin = path.join(bunInstall, "bin", "smithers");
  if (existsSync(bunBin)) return bunBin;

  return "smithers";
}

// Optional execution wrapper for the engine. RunYard is intentionally
// unopinionated about HOW/WHERE a run executes: by default the runner invokes
// the engine directly on its host. A deployer who wants per-run isolation,
// sandboxing, or container-per-build sets RUNNER_EXEC_WRAPPER and the workflow
// *launch* becomes `<wrapper...> <smithersBin> up <args>` instead of
// `<smithersBin> up <args>`. Only the launch is wrapped — the runner's
// polling/control commands (events/inspect/output/cancel) always run the binary
// directly against local state (see WRAPPED_SUBCOMMANDS in
// runnerSmithersRuntime.js), so the wrapper never sits between the runner and
// the run it supervises. The wrapper can be `docker run …`, a DinD/`docker exec`
// command, a k8s job launcher, firejail, nsjail, a custom script — whatever the
// deployer wishes. RunYard only prepends it; the deployer owns the wrapper's
// behavior (workspace sharing, lifecycle, cleanup).
//
// Tokenize an operator-supplied list value. Accepts a JSON array (precise tokens
// — use when any token contains spaces) or a plain whitespace-separated string.
// Empty/blank input yields []. Shared by the exec-wrapper and sandbox-bind
// parsing so both accept the same forgiving syntax.
export function parseCommandList(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(String).filter((s) => s.length > 0);
    } catch {
      // not valid JSON — fall through to whitespace tokenization
    }
  }
  return trimmed.split(/\s+/).filter((s) => s.length > 0);
}

// Returns [] when unset (bare host default). RUNYARD_RUNNER_EXEC_WRAPPER is an
// accepted alias.
export function resolveExecWrapper(env = process.env) {
  return parseCommandList(env.RUNNER_EXEC_WRAPPER || env.RUNYARD_RUNNER_EXEC_WRAPPER || "");
}
