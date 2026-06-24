import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-reaper-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_reaper_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { db, registerRunner, pruneDeadRunners, listRunners, getRunner } = await import("../src/db.js");

function countRunners() {
  return db.prepare("SELECT COUNT(*) AS n FROM runners").get().n;
}

function setHeartbeat(runnerId, msAgo) {
  const iso = new Date(Date.now() - msAgo).toISOString();
  db.prepare("UPDATE runners SET last_heartbeat_at = ? WHERE id = ?").run(iso, runnerId);
}

function reset() {
  db.prepare("DELETE FROM runners").run();
}

describe("idempotent runner registration (stable identity)", () => {
  it("registering twice with the same token+name+hostname and no id yields exactly one row", () => {
    reset();
    const first = registerRunner({ name: "alpha", hostname: "host-1", tags: ["smithers"] }, "tok-A");
    const second = registerRunner({ name: "alpha", hostname: "host-1", tags: ["smithers"] }, "tok-A");
    assert.equal(first.id, second.id, "second register must reuse the same row");
    assert.equal(countRunners(), 1);
  });

  it("a different token with the same name+hostname gets its own row (no hijack)", () => {
    reset();
    const a = registerRunner({ name: "alpha", hostname: "host-1" }, "tok-A");
    const b = registerRunner({ name: "alpha", hostname: "host-1" }, "tok-B");
    assert.notEqual(a.id, b.id, "a different token must never adopt another token's row");
    assert.equal(countRunners(), 2);
  });

  it("different name on the same token gets a separate row", () => {
    reset();
    registerRunner({ name: "alpha", hostname: "host-1" }, "tok-A");
    registerRunner({ name: "beta", hostname: "host-1" }, "tok-A");
    assert.equal(countRunners(), 2);
  });

  it("an explicit cached id owned by the caller updates the same row", () => {
    reset();
    const first = registerRunner({ name: "alpha", hostname: "host-1" }, "tok-A");
    const again = registerRunner({ id: first.id, name: "alpha-renamed", hostname: "host-1" }, "tok-A");
    assert.equal(again.id, first.id);
    assert.equal(again.name, "alpha-renamed");
    assert.equal(countRunners(), 1);
  });
});

describe("pruneDeadRunners", () => {
  it("deletes a runner whose heartbeat is older than the threshold", () => {
    reset();
    const dead = registerRunner({ name: "dead", hostname: "host-d" }, "tok-A");
    setHeartbeat(dead.id, 2 * 60 * 60_000); // 2h ago
    const pruned = pruneDeadRunners(60 * 60_000); // 1h threshold
    assert.deepEqual(pruned, [dead.id]);
    assert.equal(getRunner(dead.id), null);
    assert.equal(countRunners(), 0);
  });

  it("keeps a fresh runner", () => {
    reset();
    const live = registerRunner({ name: "live", hostname: "host-l" }, "tok-A");
    setHeartbeat(live.id, 30 * 60_000); // 30m ago
    assert.deepEqual(pruneDeadRunners(60 * 60_000), []);
    assert.ok(getRunner(live.id));
  });

  it("never prunes a stale runner with active_runs > 0", () => {
    reset();
    const busy = registerRunner({ name: "busy", hostname: "host-b" }, "tok-A");
    setHeartbeat(busy.id, 2 * 60 * 60_000);
    db.prepare("UPDATE runners SET active_runs = 2 WHERE id = ?").run(busy.id);
    assert.deepEqual(pruneDeadRunners(60 * 60_000), []);
    assert.ok(getRunner(busy.id), "a runner with in-flight work must survive pruning");
  });

  it("never prunes a stale runner with a non-null current_run_id", () => {
    reset();
    const claimed = registerRunner({ name: "claimed", hostname: "host-c" }, "tok-A");
    setHeartbeat(claimed.id, 2 * 60 * 60_000);
    db.prepare("UPDATE runners SET current_run_id = ? WHERE id = ?").run("run-xyz", claimed.id);
    assert.deepEqual(pruneDeadRunners(60 * 60_000), []);
    assert.ok(getRunner(claimed.id));
  });

  it("disables pruning when maxMs is 0", () => {
    reset();
    const dead = registerRunner({ name: "dead", hostname: "host-d" }, "tok-A");
    setHeartbeat(dead.id, 999 * 60 * 60_000);
    assert.deepEqual(pruneDeadRunners(0), []);
    assert.ok(getRunner(dead.id));
  });

  it("regression: ISO-8601 'T'/'Z' timestamps compare via datetime(), not raw string", () => {
    // The manual 95→2 cleanup bug: stored heartbeats are ISO ('...T..Z') while
    // datetime('now', ...) yields space-separated 'YYYY-MM-DD HH:MM:SS'. A raw
    // string compare of a same-day, older-than-threshold ISO heartbeat reads the
    // 'T' (0x54) as greater than the space (0x20) and WRONGLY KEEPS the dead row.
    // datetime() on both sides normalizes the format so the row is pruned.
    reset();
    const dead = registerRunner({ name: "iso", hostname: "host-iso" }, "tok-A");
    // Force the exact problem shape: an ISO-Z heartbeat older than the threshold.
    const isoZ = new Date(Date.now() - 90 * 60_000).toISOString(); // 90m ago, ends in 'Z'
    assert.match(isoZ, /T.*Z$/);
    db.prepare("UPDATE runners SET last_heartbeat_at = ? WHERE id = ?").run(isoZ, dead.id);
    const pruned = pruneDeadRunners(60 * 60_000); // 1h threshold
    assert.deepEqual(pruned, [dead.id], "datetime() must correctly prune an old ISO-Z heartbeat");
    assert.equal(countRunners(), 0);
  });

  it("listRunners shows a stale-but-kept runner as offline", () => {
    reset();
    const live = registerRunner({ name: "x", hostname: "host-x" }, "tok-A");
    setHeartbeat(live.id, 10 * 60_000); // older than offline window, younger than prune window
    pruneDeadRunners(60 * 60_000);
    const rows = listRunners();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].online, false);
  });
});

describe("runner client id-cache (source-level)", () => {
  const source = readFileSync(new URL("../src/smithers-runner.js", import.meta.url), "utf8");

  it("persists the assigned id under <workspace>/.smithers/runner-id", () => {
    assert.match(source, /\.smithers["'],\s*["']runner-id/);
    assert.match(source, /function cacheRunnerId/);
    assert.match(source, /function loadCachedRunnerId/);
  });

  it("seeds the id from the cache on boot and re-caches after register", () => {
    assert.match(source, /loadCachedRunnerId\(\)/);
    assert.match(source, /cacheRunnerId\(runnerId\)/);
  });

  it("tolerates a missing/corrupt id file", () => {
    // loadCachedRunnerId swallows read errors and returns "".
    assert.match(source, /catch\s*\{\s*return ""/);
  });
});
