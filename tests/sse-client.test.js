// SSE client: wire parser across arbitrary chunk boundaries, backoff math,
// and the resilient follow loop (resume, dedupe, terminal stop, fatal errors).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSseParser,
  followRunEvents,
  isAuthStreamError,
  streamBackoffDelay,
  streamRunEvents
} from "../src/sseClient.js";

function parseAll(chunks) {
  const frames = [];
  const parser = createSseParser((frame) => frames.push(frame));
  for (const chunk of chunks) parser.feed(chunk);
  return frames;
}

// A fetch stub serving a scripted sequence of connections. Each connection is
// { status?, body?: string[] (chunks) } — bodies stream chunk by chunk.
function scriptedFetch(connections) {
  let index = 0;
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const connection = connections[Math.min(index, connections.length - 1)];
    index += 1;
    if (connection.status && connection.status !== 200) {
      return {
        ok: false,
        status: connection.status,
        json: async () => ({ error: connection.error || "nope" })
      };
    }
    const chunks = [...(connection.body || [])];
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
            if (!chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks.shift()) };
          },
          releaseLock: () => {}
        }),
        cancel: async () => {}
      }
    };
  };
  return { fetchImpl, requests };
}

const event = (seq, type = "log") =>
  `id: ${seq}\nevent: run-event\ndata: ${JSON.stringify({ id: `evt_${seq}`, runId: "run_1", seq, type, message: `m${seq}` })}\n\n`;
const terminal = (status = "succeeded", lastSeq = 0) =>
  `event: run-terminal\ndata: ${JSON.stringify({ runId: "run_1", status, lastSeq })}\n\n`;
const ready = `event: ready\ndata: {"runId":"run_1","count":0,"lastSeq":-1}\n\n`;

describe("sse parser", () => {
  it("parses frames split across arbitrary chunk boundaries", () => {
    const wire = `retry: 1000\n\n: connected\n\n${ready}${event(0)}${event(1)}`;
    for (let split = 1; split < wire.length - 1; split += 7) {
      const frames = parseAll([wire.slice(0, split), wire.slice(split)]);
      assert.deepEqual(frames.map((frame) => frame.event), ["ready", "run-event", "run-event"]);
      assert.equal(frames[1].id, "0");
      assert.equal(JSON.parse(frames[2].data).seq, 1);
    }
  });

  it("joins multi-line data fields and strips one leading space", () => {
    const frames = parseAll(["event: run-event\ndata: line one\ndata:line two\ndata:  spaced\n\n"]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data, "line one\nline two\n spaced");
  });

  it("handles CRLF line endings and ignores comments", () => {
    const frames = parseAll([": ping\r\n\r\nevent: ready\r\ndata: {}\r\n\r\n"]);
    assert.deepEqual(frames.map((frame) => frame.event), ["ready"]);
  });

  it("discards an incomplete trailing event (spec behavior)", () => {
    const frames = parseAll(["event: run-event\ndata: {\"seq\":9}"]);
    assert.equal(frames.length, 0);
  });
});

describe("stream backoff", () => {
  it("mirrors the gateway backoff: exponential growth, cap, full jitter", () => {
    const fixed = { random: () => 0.5 }; // zero jitter delta
    assert.equal(streamBackoffDelay(0, fixed), 250);
    assert.equal(streamBackoffDelay(1, fixed), 500);
    assert.equal(streamBackoffDelay(2, fixed), 1000);
    assert.equal(streamBackoffDelay(10, fixed), 10_000);
    // Jitter spreads symmetrically and never goes negative.
    assert.equal(streamBackoffDelay(0, { random: () => 0 }), 125);
    assert.equal(streamBackoffDelay(0, { random: () => 1 }), 375);
    assert.ok(streamBackoffDelay(0, { random: () => -5, jitter: 5 }) >= 0);
  });
});

describe("streamRunEvents", () => {
  it("throws with status before yielding on a non-2xx response", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 401, error: "unauthorized" }]);
    await assert.rejects(
      (async () => {
        // eslint-disable-next-line no-unused-vars
        for await (const _ of streamRunEvents({ baseUrl: "http://hub", token: "t", runId: "run_1", fetchImpl })) break;
      })(),
      (error) => error.status === 401 && isAuthStreamError(error)
    );
  });

  it("sends the bearer token in a header, never in the URL", async () => {
    const { fetchImpl, requests } = scriptedFetch([{ body: [ready] }]);
    for await (const frame of streamRunEvents({ baseUrl: "http://hub/", token: "sekret", runId: "run_1", afterSeq: 3, fetchImpl })) {
      assert.equal(frame.event, "ready");
    }
    assert.equal(requests[0].url, "http://hub/api/runs/run_1/events/stream?afterSeq=3");
    assert.equal(requests[0].options.headers.authorization, "Bearer sekret");
    assert.ok(!requests[0].url.includes("sekret"));
  });
});

describe("followRunEvents", () => {
  it("streams to the terminal frame and stops cleanly", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: [ready, event(0), event(1), terminal("succeeded", 1)] }
    ]);
    const seen = [];
    for await (const frame of followRunEvents({ baseUrl: "http://hub", token: "t", runId: "run_1", fetchImpl })) {
      seen.push(frame.event);
    }
    assert.deepEqual(seen, ["ready", "run-event", "run-event", "run-terminal"]);
  });

  it("reconnects after a silent drop, resumes from the last seq, and never duplicates", async () => {
    const { fetchImpl, requests } = scriptedFetch([
      { body: [ready, event(0), event(1)] }, // drops silently without terminal
      { body: [ready, event(0), event(1), event(2), terminal("succeeded", 2)] } // replays old events
    ]);
    const seqs = [];
    for await (const frame of followRunEvents({
      baseUrl: "http://hub",
      token: "t",
      runId: "run_1",
      fetchImpl,
      backoff: { baseMs: 1, maxMs: 2, jitter: 0 }
    })) {
      if (frame.event === "run-event") seqs.push(frame.payload.seq);
    }
    assert.deepEqual(seqs, [0, 1, 2], "reconnect must not duplicate replayed events");
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /afterSeq=1$/, "second attach resumes from last seen seq");
  });

  it("throws immediately on fatal statuses (auth, unknown run, invalid cursor)", async () => {
    for (const status of [401, 403, 404, 400]) {
      const { fetchImpl, requests } = scriptedFetch([{ status }]);
      await assert.rejects(
        (async () => {
          // eslint-disable-next-line no-unused-vars
          for await (const _ of followRunEvents({ baseUrl: "http://hub", token: "t", runId: "run_1", fetchImpl })) break;
        })(),
        (error) => error.status === status
      );
      assert.equal(requests.length, 1, `status ${status} must not be retried`);
    }
  });

  it("gives up with a transport error after maxConsecutiveFailures", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    };
    await assert.rejects(
      (async () => {
        // eslint-disable-next-line no-unused-vars
        for await (const _ of followRunEvents({
          baseUrl: "http://hub",
          token: "t",
          runId: "run_1",
          fetchImpl,
          maxConsecutiveFailures: 3,
          backoff: { baseMs: 1, maxMs: 1, jitter: 0 }
        })) break;
      })(),
      (error) => error.transport === true
    );
    assert.equal(calls, 3);
  });

  it("stops without error when the signal aborts", async () => {
    const controller = new AbortController();
    const fetchImpl = async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    const seen = [];
    for await (const frame of followRunEvents({ baseUrl: "http://hub", token: "t", runId: "run_1", signal: controller.signal, fetchImpl })) {
      seen.push(frame);
    }
    assert.equal(seen.length, 0);
  });
});
