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
