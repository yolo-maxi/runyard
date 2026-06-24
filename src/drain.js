// Drain coordination — a single, dependency-free flag file that pauses runner
// claiming during an operator-initiated `runyard update`.
//
// Why a file (not a DB column or HTTP call): the runner and hub on a standard
// single-box self-host share a filesystem (both systemd units run from the same
// repo dir, see deploy/*.service), so a file under the shared dataDir is the
// simplest thing both processes can agree on without auth, network, or a schema
// change. The runner reads it before claiming; the updater writes it before the
// code swap and clears it on abort. The hub never restarts a runner mid-run.
//
// This module is intentionally side-effect-free at import time (no mkdir, no DB)
// so the runner can import it without pulling in env.js / the whole DB layer.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Resolve the Hub dataDir using the SAME precedence as src/env.js, but WITHOUT
// the mkdir side effects. Hub and runner must land on the same directory for the
// flag to be visible to both; the standard install sets SMITHERS_HUB_DATA_DIR in
// both EnvironmentFiles, and the fallback (<root>/data with a shared cwd) agrees
// too. An explicit SMITHERS_DRAIN_DIR override wins for unusual split layouts.
export function resolveDataDir(envObj = process.env) {
  const explicit = envObj.SMITHERS_DRAIN_DIR || envObj.SMITHERS_HUB_DATA_DIR;
  if (explicit) return path.resolve(explicit);
  const root = envObj.SMITHERS_HUB_ROOT || process.cwd();
  return path.join(root, "data");
}

export function drainFlagPath(dataDir = resolveDataDir()) {
  return path.join(dataDir, ".drain");
}

export function isDraining(dataDir = resolveDataDir()) {
  try {
    return existsSync(drainFlagPath(dataDir));
  } catch {
    return false;
  }
}

// Write the drain flag. Content is a small JSON record for operator visibility
// (who/why/when); the mere existence of the file is what gates claiming, so a
// malformed/empty file still drains — fail safe, never fail open.
export function setDrain(dataDir = resolveDataDir(), info = {}) {
  const file = drainFlagPath(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    reason: String(info.reason || "update"),
    targetTag: info.targetTag ? String(info.targetTag) : "",
    setBy: String(info.setBy || ""),
    setAt: info.setAt ? String(info.setAt) : new Date().toISOString()
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  return record;
}

export function clearDrain(dataDir = resolveDataDir()) {
  try {
    rmSync(drainFlagPath(dataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readDrain(dataDir = resolveDataDir()) {
  try {
    const raw = readFileSync(drainFlagPath(dataDir), "utf8").trim();
    if (!raw) return { reason: "update" };
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
