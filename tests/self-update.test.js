import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { drainRunners, waitForHealth, writeLastGood, readLastGood, hasLastGood, decideHubRestart, lastGoodPath } =
  await import("../src/selfUpdate.js");
const { setDrain, clearDrain, isDraining, readDrain, drainFlagPath, resolveDataDir } = await import("../src/drain.js");

// Deterministic clock: sleep() advances virtual time instantly so grace-window
// and timeout logic is exercised without any real waiting.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    }
  };
}

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("drainRunners", () => {
  it("sets the drain flag and proceeds immediately when nothing is in flight", async () => {
    const clock = fakeClock();
    let setCalls = 0;
    let clearCalls = 0;
    const result = await drainRunners({
      getActiveCount: () => 0,
      setDrain: () => setCalls++,
      clearDrain: () => clearCalls++,
      graceMs: 1000,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep
    });
    assert.equal(result.drained, true);
    assert.equal(result.active, 0);
    assert.equal(setCalls, 1, "drain flag must be set");
    assert.equal(clearCalls, 0, "no need to clear on a clean drain");
  });

  it("waits while active_runs > 0 and proceeds once it reaches 0", async () => {
    const clock = fakeClock();
    const counts = [2, 2, 1, 0];
    let i = 0;
    const result = await drainRunners({
      getActiveCount: () => counts[Math.min(i++, counts.length - 1)],
      setDrain: () => {},
      clearDrain: () => {},
      graceMs: 1_000_000,
      intervalMs: 10,
      now: clock.now,
      sleep: clock.sleep
    });
    assert.equal(result.drained, true);
    assert.equal(result.active, 0);
    assert.equal(i, 4, "must keep polling until the count hits zero");
  });

  it("aborts and clears the flag when the grace window is exceeded", async () => {
    const clock = fakeClock();
    let clearCalls = 0;
    const result = await drainRunners({
      getActiveCount: () => 2, // never drains
      setDrain: () => {},
      clearDrain: () => clearCalls++,
      graceMs: 50,
      intervalMs: 20,
      now: clock.now,
      sleep: clock.sleep
    });
    assert.equal(result.drained, false);
    assert.equal(result.reason, "grace_window_exceeded");
    assert.equal(result.active, 2);
    assert.equal(clearCalls, 1, "an aborted drain must clear the flag so the box isn't left wedged");
  });
});

describe("waitForHealth", () => {
  it("returns true as soon as the check passes", async () => {
    const clock = fakeClock();
    const seq = [false, false, true];
    let i = 0;
    const ok = await waitForHealth({
      check: () => seq[Math.min(i++, seq.length - 1)],
      timeoutMs: 10000,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep
    });
    assert.equal(ok, true);
  });

  it("returns false when health never recovers within the window", async () => {
    const clock = fakeClock();
    const ok = await waitForHealth({
      check: () => false,
      timeoutMs: 50,
      intervalMs: 20,
      now: clock.now,
      sleep: clock.sleep
    });
    assert.equal(ok, false);
  });

  it("treats a throwing check as not-yet-healthy", async () => {
    const clock = fakeClock();
    let i = 0;
    const ok = await waitForHealth({
      check: () => {
        if (i++ < 1) throw new Error("connection refused");
        return true;
      },
      timeoutMs: 10000,
      intervalMs: 50,
      now: clock.now,
      sleep: clock.sleep
    });
    assert.equal(ok, true);
  });
});

describe("last-known-good marker", () => {
  it("round-trips tag/commit under dataDir and is missing-safe", () => {
    const dir = tempDir("runyard-lastgood-");
    assert.equal(readLastGood(dir), null, "absent marker reads as null");
    assert.equal(hasLastGood(dir), false);
    const written = writeLastGood(dir, { tag: "v1.2.3", commit: "abc1234" });
    assert.equal(written.tag, "v1.2.3");
    assert.equal(written.commit, "abc1234");
    assert.ok(written.recordedAt);
    assert.equal(hasLastGood(dir), true);
    const read = readLastGood(dir);
    assert.equal(read.tag, "v1.2.3");
    assert.equal(read.commit, "abc1234");
    assert.equal(lastGoodPath(dir), path.join(dir, ".last-good-release"));
  });
});

describe("hub vs runner restart asymmetry", () => {
  it("restarts the hub when nothing is running", () => {
    assert.equal(decideHubRestart({ runningCount: 0, drained: true }).restart, true);
  });
  it("defers when runs are still running and drain is incomplete", () => {
    const d = decideHubRestart({ runningCount: 3, drained: false });
    assert.equal(d.restart, false);
    assert.match(d.reason, /defer/);
  });
  it("defers when the live counter still shows running even if drain reported clear", () => {
    assert.equal(decideHubRestart({ runningCount: 1, drained: true }).restart, false);
  });
  it("honors force (e.g. grace already elapsed)", () => {
    assert.equal(decideHubRestart({ runningCount: 5, drained: false, force: true }).restart, true);
  });
});

describe("drain flag file (shared hub/runner coordination)", () => {
  it("set -> isDraining -> readDrain -> clear", () => {
    const dir = tempDir("runyard-drain-");
    assert.equal(isDraining(dir), false);
    setDrain(dir, { reason: "update", targetTag: "v2.0.0", setBy: "test" });
    assert.equal(isDraining(dir), true);
    const info = readDrain(dir);
    assert.equal(info.reason, "update");
    assert.equal(info.targetTag, "v2.0.0");
    assert.equal(drainFlagPath(dir), path.join(dir, ".drain"));
    clearDrain(dir);
    assert.equal(isDraining(dir), false);
    assert.equal(readDrain(dir), null);
  });

  it("resolveDataDir honors SMITHERS_HUB_DATA_DIR (hub/runner agree on the path)", () => {
    const dir = "/tmp/runyard-shared-xyz";
    assert.equal(resolveDataDir({ SMITHERS_HUB_DATA_DIR: dir }), path.resolve(dir));
  });
});

// Re-exec safety + rollback robustness are properties of the shell orchestrator
// that we assert at the source level — they are exactly where a self-update can
// brick a box, so the guarantees are pinned by tests.
describe("runyard-update.sh re-exec + rollback safety (source-level)", () => {
  const script = readFileSync(new URL("../scripts/runyard-update.sh", import.meta.url), "utf8");

  it("copies itself to a temp file and re-execs before touching the working tree", () => {
    assert.match(script, /RUNYARD_UPDATE_REEXEC/);
    assert.match(script, /mktemp/);
    assert.match(script, /exec bash "\$tmp_self"/);
  });

  it("removes the temp copy on exit", () => {
    assert.match(script, /trap 'rm -f "\$0"' EXIT/);
  });

  it("records last-known-good and drains BEFORE the checkout", () => {
    const recordIdx = script.indexOf("record-last-good");
    const drainIdx = script.indexOf("helper drain");
    const checkoutIdx = script.indexOf("git checkout -q \"tags/$TARGET_TAG\"");
    assert.ok(recordIdx > 0 && drainIdx > 0 && checkoutIdx > 0);
    assert.ok(recordIdx < checkoutIdx, "last-good must be recorded before checkout");
    assert.ok(drainIdx < checkoutIdx, "drain must happen before checkout");
  });

  it("rolls back using shell-captured CURRENT_TAG/CURRENT_COMMIT, not a node/file read", () => {
    // The rollback path must survive a completely broken new release, so it must
    // not depend on the (possibly broken) new code or a parsed file.
    assert.match(script, /rollback\(\)/);
    assert.match(script, /good_ref="tags\/\$CURRENT_TAG"/);
    assert.match(script, /good_ref="\$CURRENT_COMMIT"/);
  });

  it("auto-rolls-back on a failed healthcheck and only installs deps when the lockfile changed", () => {
    assert.match(script, /check_health \|\| rollback/);
    assert.match(script, /OLD_LOCK_HASH" != "\$NEW_LOCK_HASH/);
  });

  it("aborts (no changes) when drain times out", () => {
    assert.match(script, /drain timed out; update aborted \(no changes made\)/);
  });
});

describe("runner drain gate (source-level)", () => {
  const source = readFileSync(new URL("../src/runner.js", import.meta.url), "utf8");

  it("imports the drain helper and checks it before claiming", () => {
    assert.match(source, /import \{ isDraining, resolveDataDir \} from "\.\/drain\.js"/);
    assert.match(source, /if \(isDraining\(drainDataDir\)\)/);
  });

  it("still heartbeats while draining (claiming is gated, not the whole tick)", () => {
    // The heartbeat post precedes the drain gate in tick(); the gate only wraps
    // the claim loop, so a draining runner keeps reporting + finishing work.
    const heartbeatIdx = source.indexOf("/heartbeat`");
    const gateIdx = source.indexOf("if (isDraining(drainDataDir))");
    assert.ok(heartbeatIdx > 0 && gateIdx > heartbeatIdx, "heartbeat must run before the drain gate");
  });
});
