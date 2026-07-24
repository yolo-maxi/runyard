// Per-run event sequencing: migration backfill idempotency, monotonic
// assignment under rapid interleaved inserts, and cursor paging.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-seq-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";

const {
  addRunEvent,
  createRun,
  db,
  getCapability,
  initDb,
  listRunEvents,
  listRunEventsAfter
} = await import("../src/db.js");

function insertLegacyEvent(runId, id, createdAt, type = "legacy") {
  // What a pre-seq binary writes: no seq column value at all.
  db.prepare(
    "INSERT INTO run_events (id, run_id, type, message, data, created_at) VALUES (?, ?, ?, ?, '{}', ?)"
  ).run(id, runId, type, `${type} message`, createdAt);
}

describe("run event seq", () => {
  let run;
  before(() => {
    run = createRun(getCapability("hello"), { topic: "seq" }, {});
  });

  it("assigns 0-based monotonic seqs in insert order", () => {
    // createRun already emitted run.created at seq 0.
    const first = addRunEvent(run.id, "step.one", "one");
    const second = addRunEvent(run.id, "step.two", "two");
    assert.equal(typeof first.seq, "number");
    assert.equal(second.seq, first.seq + 1);
    const events = listRunEvents(run.id);
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));
    assert.equal(events[0].seq, 0);
  });

  it("keeps seqs per-run independent and collision-free under rapid interleaved inserts", () => {
    const other = createRun(getCapability("hello"), { topic: "seq2" }, {});
    for (let i = 0; i < 50; i++) {
      addRunEvent(run.id, "burst", `a${i}`);
      addRunEvent(other.id, "burst", `b${i}`);
    }
    for (const runId of [run.id, other.id]) {
      const seqs = listRunEvents(runId).map((event) => event.seq);
      assert.equal(new Set(seqs).size, seqs.length, "no duplicate seq per run");
      for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], "strictly increasing");
    }
  });

  it("rejects a manually forced duplicate seq via the unique index", () => {
    const events = listRunEvents(run.id);
    const taken = events[events.length - 1].seq;
    assert.throws(() => {
      db.prepare(
        "INSERT INTO run_events (id, run_id, type, message, data, seq, created_at) VALUES ('evt_dup', ?, 'dup', '', '{}', ?, '2026-01-01T00:00:00.000Z')"
      ).run(run.id, taken);
    }, /UNIQUE/i);
  });

  it("backfills legacy NULL-seq rows deterministically, idempotently, and without renumbering", () => {
    const legacyRun = createRun(getCapability("hello"), { topic: "legacy" }, {});
    const existing = listRunEvents(legacyRun.id);
    const preservedSeqs = existing.map((event) => [event.id, event.seq]);
    const maxSeq = Math.max(...existing.map((event) => event.seq));

    // Simulate rows written by an old binary (downgrade window), out of
    // insertion order relative to their ids to prove created_at ordering.
    insertLegacyEvent(legacyRun.id, "evt_legacy_b", "2026-01-02T00:00:00.000Z");
    insertLegacyEvent(legacyRun.id, "evt_legacy_a", "2026-01-01T00:00:00.000Z");
    insertLegacyEvent(legacyRun.id, "evt_legacy_c", "2026-01-02T00:00:00.000Z"); // tie -> rowid order

    initDb(); // runs migrateRunEventsSeqColumn's backfill again

    const events = listRunEvents(legacyRun.id);
    const byId = Object.fromEntries(events.map((event) => [event.id, event.seq]));
    // Existing seqs untouched.
    for (const [id, seq] of preservedSeqs) assert.equal(byId[id], seq);
    // NULL rows got the next cursors in (created_at, rowid) order.
    assert.equal(byId.evt_legacy_a, maxSeq + 1);
    assert.equal(byId.evt_legacy_b, maxSeq + 2);
    assert.equal(byId.evt_legacy_c, maxSeq + 3);

    // Idempotent: running the migration again changes nothing.
    initDb();
    const again = listRunEvents(legacyRun.id).map((event) => [event.id, event.seq]);
    assert.deepEqual(again, events.map((event) => [event.id, event.seq]));

    // New inserts continue after the backfilled tail.
    const next = addRunEvent(legacyRun.id, "post.backfill", "next");
    assert.equal(next.seq, maxSeq + 4);
  });

  it("pages events after a cursor in bounded batches", () => {
    const pagedRun = createRun(getCapability("hello"), { topic: "paging" }, {});
    for (let i = 0; i < 10; i++) addRunEvent(pagedRun.id, "page", `p${i}`);
    const all = listRunEvents(pagedRun.id);
    const page = listRunEventsAfter(pagedRun.id, 2, 4);
    assert.equal(page.length, 4);
    assert.deepEqual(page.map((event) => event.seq), [3, 4, 5, 6]);
    const tail = listRunEventsAfter(pagedRun.id, all[all.length - 1].seq, 4);
    assert.equal(tail.length, 0);
  });
});

after(() => {
  db.close();
});
