// One incremental Smithers event follower per owned run, replacing the old
// "re-run `smithers events --limit 100000` every poll and diff the suffix"
// loop. Modeled on Smithers' own CLI follow paths: a single long-lived
// `smithers events <sid> --json --watch` child streams NDJSON
// ({runId, seq, timestampMs, type, payload}) to stdout — initial backlog
// first, then incremental pages every interval, then a terminal drain before
// the child exits on its own (see @smithers-orchestrator/cli events command
// + runWatchLoop).
//
// This module owns the child lifecycle:
//   - chunk-boundary-safe line parsing of the child's stdout,
//   - per-run seq dedupe, so a restart's backlog replay never re-posts an
//     event the Hub already has (mirrors resume-from-lastSeq in
//     streamRunEventsResilient),
//   - serialized async onLine delivery (Hub posts stay in event order),
//   - restart with exponential backoff while the run is live; gives up after
//     maxConsecutiveFailures so a broken CLI can't spin forever (the caller
//     falls back to one full-history fetch at collection time),
//   - stop(): SIGTERM, SIGKILL after a grace period, restart suppressed — no
//     leaked/zombie follower processes.
//
// `events` is a control-plane subcommand (reads local .smithers state, runs
// no untrusted code), so the caller spawns it UNWRAPPED like every other
// polling command — see WRAPPED_SUBCOMMANDS in runnerSmithersRuntime.js.

export function smithersFollowerArgs(sid, { intervalSeconds = 1, backlogLimit = 100_000 } = {}) {
  return ["events", String(sid), "--json", "--watch", "--interval", String(intervalSeconds), "--limit", String(backlogLimit)];
}

export function createSmithersEventFollower({
  spawnFollower,
  onLine = async () => {},
  logError = () => {},
  backoffDelayMs = (attempt) => Math.min(10_000, 500 * 2 ** attempt),
  maxConsecutiveFailures = 10,
  healthyAfterMs = 5_000,
  killGraceMs = 5_000,
  // The watch CLI also exits 0 when something ELSE signals it mid-run
  // (runWatchLoop treats SIGTERM/SIGINT as a clean stop). Before trusting a
  // zero exit as "terminal drain complete", the caller can verify the engine
  // run really is terminal; a false answer restarts the follower instead of
  // silently truncating the stream. Default true = trust exit 0.
  isEngineTerminal = async () => true
} = {}) {
  let child = null;
  let stopped = false;
  let completed = false;
  let gaveUp = false;
  let consecutiveFailures = 0;
  let lastSeq = -1;
  const lines = []; // fresh NDJSON lines in seq order (terminal artifact source)

  // Serialized line delivery: parse fast, deliver one at a time so the Hub
  // sees events in order even when the child bursts a whole backlog page.
  // Flow control: when Hub posts fall behind a bursting child, pause the
  // child's stdout at PENDING_HIGH_WATER and resume below the low water —
  // the undelivered queue stays bounded instead of growing with the burst.
  const PENDING_HIGH_WATER = 1_000;
  const PENDING_LOW_WATER = 200;
  const pending = [];
  let delivering = false;
  let idleResolvers = [];
  async function deliver() {
    if (delivering) return;
    delivering = true;
    try {
      while (pending.length) {
        const line = pending.shift();
        if (pending.length <= PENDING_LOW_WATER) child?.stdout?.resume?.();
        try {
          await onLine(line.raw, line.parsed);
        } catch (error) {
          logError(`follower onLine failed: ${error?.message || error}`);
        }
      }
    } finally {
      delivering = false;
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  function acceptLine(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // `events --json` stdout is pure NDJSON; anything else is noise (and
      // has no seq, so passing it through would double-post on restart).
      logError(`follower skipped non-JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }
    const seq = Number(parsed?.seq);
    if (Number.isFinite(seq)) {
      if (seq <= lastSeq) return; // restart backlog replay — already posted
      lastSeq = seq;
      consecutiveFailures = 0; // a fresh, deduped event proves health
    }
    lines.push(trimmed);
    pending.push({ raw: trimmed, parsed });
    if (pending.length >= PENDING_HIGH_WATER) child?.stdout?.pause?.();
    deliver();
  }

  let exitResolvers = [];
  function notifyExit() {
    const resolvers = exitResolvers;
    exitResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  function launch() {
    if (stopped || gaveUp) return;
    let spawned;
    try {
      spawned = spawnFollower();
    } catch (error) {
      logError(`follower spawn failed: ${error?.message || error}`);
      scheduleRestart();
      return;
    }
    child = spawned;
    const startedAt = Date.now();
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        acceptLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr?.on("data", () => {
      /* watch-mode warnings (interval clamp etc.) — not ours to surface */
    });
    child.on("error", (error) => {
      logError(`follower process error: ${error?.message || error}`);
    });
    child.once("exit", async (code) => {
      if (buffer.trim()) acceptLine(buffer); // final unterminated line
      buffer = "";
      child = null;
      if (stopped) {
        notifyExit();
        return;
      }
      if (code === 0) {
        // The watch loop exits 0 once the engine run is terminal and the
        // remaining pages are drained — but ALSO when an external signal
        // stopped it mid-run. Cross-check before trusting it.
        let terminal = true;
        try {
          terminal = await isEngineTerminal();
        } catch {
          terminal = false;
        }
        if (stopped) {
          notifyExit();
          return;
        }
        if (terminal) {
          completed = true;
          notifyExit();
          return;
        }
        logError("follower exited 0 but the engine run is still live (external signal?); restarting");
        scheduleRestart();
        return;
      }
      if (Date.now() - startedAt >= healthyAfterMs) consecutiveFailures = 0;
      logError(`follower exited with code ${code}; restarting`);
      scheduleRestart();
    });
  }

  let restartTimer = null;
  function scheduleRestart() {
    if (stopped || gaveUp) {
      notifyExit();
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      gaveUp = true;
      logError(`follower gave up after ${consecutiveFailures} consecutive failures; final collection will fall back to a full event fetch`);
      notifyExit();
      return;
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, backoffDelayMs(consecutiveFailures - 1));
  }

  function waitForIdle() {
    if (!delivering && pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleResolvers.push(resolve));
  }

  // Resolves once the follower will produce no more lines by itself (clean
  // terminal exit, gave up, or stopped) or after timeoutMs.
  function waitForExit(timeoutMs = 15_000) {
    if (!child && (completed || gaveUp || stopped)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      exitResolvers.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async function stop() {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const current = child;
    if (current) {
      const exited = new Promise((resolve) => {
        current.once("exit", resolve);
        if (current.exitCode !== null) resolve();
      });
      try {
        current.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const killTimer = setTimeout(() => {
        try {
          current.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, killGraceMs);
      await exited;
      clearTimeout(killTimer);
      child = null;
    }
    await waitForIdle();
    notifyExit();
  }

  return {
    start: launch,
    stop,
    waitForExit,
    waitForIdle,
    lines,
    lastSeq: () => lastSeq,
    isCompleted: () => completed,
    isGivenUp: () => gaveUp
  };
}
