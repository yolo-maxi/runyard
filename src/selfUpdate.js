// Operator-initiated APPLY logic — the decision/coordination half of
// `runyard update`. The dangerous side effects (git checkout, pnpm install,
// systemctl restart) live in scripts/runyard-update.sh, which is re-exec-safe
// against the code swap. This module holds the parts worth unit-testing in
// isolation: draining runners, polling health, the last-known-good marker, and
// the hub-vs-runner restart asymmetry. Every function takes its clock, sleeper,
// and I/O by injection so tests run with a fake clock and no real waiting.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LAST_GOOD_FILENAME = ".last-good-release";

export function lastGoodPath(dataDir) {
  return path.join(dataDir, LAST_GOOD_FILENAME);
}

// Record the currently-running tag/commit as the rollback target BEFORE we touch
// the working tree. Persisted under dataDir so it survives the code swap and a
// rollback (data/ is never mutated by the updater except for this marker).
export function writeLastGood(dataDir, { tag = "", commit = "", recordedAt } = {}) {
  const file = lastGoodPath(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    tag: String(tag || ""),
    commit: String(commit || ""),
    recordedAt: recordedAt || new Date().toISOString()
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  return record;
}

export function readLastGood(dataDir) {
  try {
    const raw = readFileSync(lastGoodPath(dataDir), "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function hasLastGood(dataDir) {
  return existsSync(lastGoodPath(dataDir));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drain runners: set the .drain flag (runners stop claiming new work, finish
// in-flight), then poll the active-run count until it hits zero or the bounded
// grace window expires. Default behavior is ALWAYS "wait, don't kill in-flight
// work" — on timeout we clear the flag (so the box isn't left wedged in drain)
// and report failure so the caller aborts the update with a non-zero exit.
//
// deps:
//   getActiveCount() -> number  (assigned+running runs, the work that must finish)
//   setDrain() / clearDrain()   (write/remove the flag)
//   graceMs, intervalMs         (bounded window + poll cadence)
//   now(), sleep(ms), log(msg)  (injected clock/sleeper/logger)
export async function drainRunners({
  getActiveCount,
  setDrain,
  clearDrain,
  graceMs,
  intervalMs = 5000,
  now = () => Date.now(),
  sleep = defaultSleep,
  log = () => {}
}) {
  if (typeof getActiveCount !== "function") throw new Error("drainRunners: getActiveCount is required");
  setDrain?.();
  const deadline = now() + graceMs;
  // Check immediately first so an idle box drains instantly (no wasted interval).
  for (;;) {
    let active;
    try {
      active = Number(getActiveCount()) || 0;
    } catch (error) {
      // A transient read failure shouldn't decide the drain; treat as "still
      // busy" and let the grace window govern, rather than proceeding blind.
      active = Number.POSITIVE_INFINITY;
      log(`drain: active-count read failed (${error?.message || error}); will retry`);
    }
    if (active <= 0) {
      log("drain: 0 active runs — drained");
      return { drained: true, active: 0 };
    }
    if (now() >= deadline) {
      // Abort: never proceed with in-flight work, and don't leave the box drained.
      clearDrain?.();
      log(`drain: grace window of ${graceMs}ms exceeded with ${active} active run(s); aborting`);
      return { drained: false, active, reason: "grace_window_exceeded" };
    }
    log(`drain: ${active} active run(s) remaining; waiting…`);
    await sleep(intervalMs);
  }
}

// Poll a health check until it passes or the timeout expires. `check()` returns
// truthy when healthy (e.g. GET /healthz -> 200). Used both after the swap (to
// decide success vs rollback) and after a rollback (to confirm recovery).
export async function waitForHealth({
  check,
  timeoutMs = 30000,
  intervalMs = 2000,
  now = () => Date.now(),
  sleep = defaultSleep,
  log = () => {}
}) {
  if (typeof check !== "function") throw new Error("waitForHealth: check is required");
  const deadline = now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let ok = false;
    try {
      ok = Boolean(await check());
    } catch {
      ok = false;
    }
    if (ok) {
      log(`health: passed on attempt ${attempt}`);
      return true;
    }
    if (now() >= deadline) {
      log(`health: still failing after ${timeoutMs}ms (${attempt} attempt(s))`);
      return false;
    }
    await sleep(intervalMs);
  }
}

// Hub vs runner asymmetry, encoded. Runners MUST drain — a mid-run restart
// destroys the agent's in-flight work, which is not durable. The hub is
// different: Smithers runs are DB-durable and resume after a bounce, so the hub
// may restart more freely. We still PREFER to restart the hub only when nothing
// is actively `running`, deferring otherwise unless the caller forces it (e.g.
// the grace window already elapsed). Returns a decision the orchestrator logs.
export function decideHubRestart({ runningCount = 0, drained = true, force = false } = {}) {
  if (force) return { restart: true, reason: "forced" };
  if (runningCount > 0 && !drained) {
    return { restart: false, reason: `deferring: ${runningCount} run(s) still running and drain incomplete` };
  }
  if (runningCount > 0 && drained) {
    // Drain reported clear but the live counter still shows running — be cautious.
    return { restart: false, reason: `deferring: ${runningCount} run(s) still reported running` };
  }
  return { restart: true, reason: "no runs currently running" };
}
