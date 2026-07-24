// End-to-end SSE contract over the real Hub HTTP server: auth, precise
// pre-stream errors, cursor replay (afterSeq + Last-Event-ID), id: frames,
// live tail without loss or duplication, terminal drain-then-close, subscriber
// caps, and disconnect cleanup.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-sse-test-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");
const { addRunEvent, createRun, getCapability, transitionRun } = await import("../src/db.js");
const { subscriberCount } = await import("../src/runEventBus.js");

const token = "shub_test_token";
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function streamUrl(runId, query = "") {
  return `${baseUrl}/api/runs/${runId}/events/stream${query}`;
}

// Read SSE frames from a live response until `until(frames)` is true or the
// stream ends; returns { frames, ended }. Aborts the connection on return.
async function readFrames(response, { until = () => false, timeoutMs = 5000, controller } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";
  let eventName = "";
  let dataLines = [];
  let id;
  let ended = false;
  const deadline = Date.now() + timeoutMs;
  const flushLine = (line) => {
    if (line === "") {
      if (dataLines.length || eventName || id !== undefined) {
        frames.push({ event: eventName || "message", data: dataLines.join("\n"), id });
      }
      eventName = "";
      dataLines = [];
      id = undefined;
      return;
    }
    if (line.startsWith(":")) {
      frames.push({ event: "comment", data: line.slice(1).trim() });
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
    else if (field === "retry") frames.push({ event: "retry", data: value });
  };
  try {
    while (Date.now() < deadline && !until(frames)) {
      const race = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), Math.max(1, deadline - Date.now())))
      ]);
      if (race === "timeout") break;
      const { done, value } = race;
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        flushLine(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
      }
    }
  } finally {
    try {
      controller?.abort();
      reader.releaseLock();
    } catch {
      /* closed */
    }
  }
  return { frames, ended };
}

function openStream(runId, { query = "", headers = {} } = {}) {
  const controller = new AbortController();
  const response = fetch(streamUrl(runId, query), {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", ...headers },
    signal: controller.signal
  });
  return { response, controller };
}

const runEvents = (frames) => frames.filter((frame) => frame.event === "run-event").map((frame) => JSON.parse(frame.data));

describe("run events SSE stream", () => {
  it("requires auth before opening the stream", async () => {
    const run = createRun(getCapability("hello"), {}, {});
    const response = await fetch(streamUrl(run.id));
    assert.equal(response.status, 401);
  });

  it("404s for an unknown run and 400s for an invalid cursor before streaming", async () => {
    const missing = await fetch(streamUrl("run_nope"), { headers: { authorization: `Bearer ${token}` } });
    assert.equal(missing.status, 404);

    const run = createRun(getCapability("hello"), {}, {});
    const invalid = await fetch(streamUrl(run.id, "?afterSeq=banana"), { headers: { authorization: `Bearer ${token}` } });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /invalid event cursor/);

    const negative = await fetch(streamUrl(run.id, "?afterSeq=-9"), { headers: { authorization: `Bearer ${token}` } });
    assert.equal(negative.status, 400);
  });

  it("replays history with id:<seq> frames, tails live events, and closes after terminal drain", async () => {
    const run = createRun(getCapability("hello"), { topic: "stream" }, {});
    addRunEvent(run.id, "before.attach", "already here");

    const { response, controller } = openStream(run.id);
    const settled = await response;
    assert.equal(settled.status, 200);
    assert.match(settled.headers.get("content-type"), /text\/event-stream/);

    // Read to EOF — the server must close the socket itself after the
    // terminal drain, so `ended` comes from a genuine stream end.
    const collected = readFrames(settled, { controller, timeoutMs: 8000 });

    // Live events + terminal transition while the stream is attached.
    setTimeout(() => {
      addRunEvent(run.id, "live.one", "first live");
      addRunEvent(run.id, "live.two", "second live");
      transitionRun(run.id, "running", {});
      transitionRun(run.id, "succeeded", {});
    }, 150);

    const { frames, ended } = await collected;
    const ready = frames.find((frame) => frame.event === "ready");
    assert.ok(ready, "ready preamble kept for the web console");
    assert.equal(JSON.parse(ready.data).runId, run.id);
    assert.ok(frames.some((frame) => frame.event === "retry" && frame.data === "1000"));

    const events = runEvents(frames);
    const types = events.map((event) => event.type);
    assert.ok(types.includes("run.created"), "replay includes persisted history");
    assert.ok(types.includes("before.attach"));
    assert.ok(types.includes("live.one") && types.includes("live.two"), "live tail after replay");
    // Every frame id matches its payload seq, strictly increasing, no dupes.
    const eventFrames = frames.filter((frame) => frame.event === "run-event");
    for (const frame of eventFrames) assert.equal(String(JSON.parse(frame.data).seq), frame.id);
    const seqs = events.map((event) => event.seq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], "strictly increasing, no duplicates");

    const terminal = frames.find((frame) => frame.event === "run-terminal");
    assert.ok(terminal, "terminal frame sent before close");
    assert.equal(JSON.parse(terminal.data).status, "succeeded");
    assert.equal(ended, true, "stream closes after terminal drain");
  });

  it("resumes from ?afterSeq and Last-Event-ID without duplicates", async () => {
    const run = createRun(getCapability("hello"), { topic: "resume" }, {});
    for (let i = 0; i < 5; i++) addRunEvent(run.id, `evt.${i}`, `event ${i}`);
    transitionRun(run.id, "running", {});
    transitionRun(run.id, "succeeded", {});

    const viaQuery = openStream(run.id, { query: "?afterSeq=2" });
    const queryFrames = await readFrames(await viaQuery.response, {
      controller: viaQuery.controller,
      until: (frames) => frames.some((frame) => frame.event === "run-terminal")
    });
    assert.deepEqual(runEvents(queryFrames.frames).map((event) => event.seq), [3, 4, 5]);

    const viaHeader = openStream(run.id, { headers: { "Last-Event-ID": "4" } });
    const headerFrames = await readFrames(await viaHeader.response, {
      controller: viaHeader.controller,
      until: (frames) => frames.some((frame) => frame.event === "run-terminal")
    });
    assert.deepEqual(runEvents(headerFrames.frames).map((event) => event.seq), [5]);

    // Query param wins over the header when both are present.
    const both = openStream(run.id, { query: "?afterSeq=5", headers: { "Last-Event-ID": "0" } });
    const bothFrames = await readFrames(await both.response, {
      controller: both.controller,
      until: (frames) => frames.some((frame) => frame.event === "run-terminal")
    });
    assert.deepEqual(runEvents(bothFrames.frames).map((event) => event.seq), []);
  });

  it("answers 204 to caught-up EventSource reconnects of terminal runs (no reconnect loop)", async () => {
    const run = createRun(getCapability("hello"), { topic: "reconnect-204" }, {});
    addRunEvent(run.id, "only", "one event");
    transitionRun(run.id, "running", {});
    transitionRun(run.id, "succeeded", {});
    const lastSeq = (await (await fetch(`${baseUrl}/api/runs/${run.id}/events`, { headers: { authorization: `Bearer ${token}` } })).json())
      .events.at(-1).seq;

    // Browser reconnect (Last-Event-ID) already caught up -> 204 stops EventSource.
    const caughtUp = await fetch(streamUrl(run.id), {
      headers: { authorization: `Bearer ${token}`, "Last-Event-ID": String(lastSeq) }
    });
    assert.equal(caughtUp.status, 204);

    // Same reconnect but with events still to replay -> normal 200 stream.
    const behind = openStream(run.id, { headers: { "Last-Event-ID": String(lastSeq - 1) } });
    const behindResponse = await behind.response;
    assert.equal(behindResponse.status, 200);
    const behindFrames = await readFrames(behindResponse, {
      controller: behind.controller,
      until: (frames) => frames.some((frame) => frame.event === "run-terminal")
    });
    assert.deepEqual(runEvents(behindFrames.frames).map((event) => event.seq), [lastSeq]);

    // The CLI's explicit ?afterSeq NEVER gets 204 — it needs the terminal frame.
    const cli = openStream(run.id, { query: `?afterSeq=${lastSeq}` });
    const cliResponse = await cli.response;
    assert.equal(cliResponse.status, 200);
    const cliFrames = await readFrames(cliResponse, {
      controller: cli.controller,
      until: (frames) => frames.some((frame) => frame.event === "run-terminal")
    });
    assert.ok(cliFrames.frames.some((frame) => frame.event === "run-terminal"));
  });

  it("enforces the per-run subscriber cap with a 429 before the stream opens", async () => {
    process.env.RUNYARD_SSE_MAX_TAILS_PER_RUN = "1";
    try {
      const run = createRun(getCapability("hello"), { topic: "caps" }, {});
      const first = openStream(run.id);
      const settled = await first.response;
      assert.equal(settled.status, 200);
      // Wait for the first tail to register on the bus.
      const deadline = Date.now() + 2000;
      while (subscriberCount(run.id) < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(subscriberCount(run.id), 1);

      const second = await fetch(streamUrl(run.id), { headers: { authorization: `Bearer ${token}` } });
      assert.equal(second.status, 429);

      // Disconnect cleanup: aborting the first tail frees the slot.
      first.controller.abort();
      const cleanupDeadline = Date.now() + 3000;
      while (subscriberCount(run.id) > 0 && Date.now() < cleanupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(subscriberCount(run.id), 0, "server unsubscribes on client disconnect");
    } finally {
      delete process.env.RUNYARD_SSE_MAX_TAILS_PER_RUN;
    }
  });

  it("never loses an event raced against attach (persist-then-poll design)", async () => {
    const run = createRun(getCapability("hello"), { topic: "race" }, {});
    // Fire events continuously while attaching; every persisted seq must
    // arrive exactly once, in order.
    const writer = setInterval(() => addRunEvent(run.id, "race", "tick"), 5);
    const { response, controller } = openStream(run.id);
    const settled = await response;
    setTimeout(() => {
      clearInterval(writer);
      transitionRun(run.id, "running", {});
      transitionRun(run.id, "succeeded", {});
    }, 300);
    const { frames } = await readFrames(settled, {
      controller,
      timeoutMs: 8000,
      until: (collected) => collected.some((frame) => frame.event === "run-terminal")
    });
    clearInterval(writer);
    const seqs = runEvents(frames).map((event) => event.seq);
    assert.ok(seqs.length >= 3);
    // Exactly the full contiguous range 0..max — nothing lost, nothing doubled.
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i));
  });
});
