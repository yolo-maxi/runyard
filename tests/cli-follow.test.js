// CLI follow contract: NDJSON/text stdout, stderr separation, stable exit
// codes, reconnect resume, Ctrl-C detach WITHOUT cancelling the remote run.
// Unit tests drive followRun with a scripted fetch; process tests spawn the
// real CLI against a stub hub HTTP server.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  exitCodeForRunStatus,
  FOLLOW_EXIT,
  followEventEnvelope,
  followRun,
  followTerminalEnvelope
} from "../src/cliFollow.js";

function sink() {
  const chunks = [];
  return {
    write: (chunk) => chunks.push(String(chunk)),
    text: () => chunks.join(""),
    lines: () => chunks.join("").split("\n").filter(Boolean)
  };
}

const wireEvent = (seq, type = "log", message = `m${seq}`) =>
  `id: ${seq}\nevent: run-event\ndata: ${JSON.stringify({
    id: `evt_${seq}`, runId: "run_1", seq, type, message, createdAt: "2026-07-23T00:00:00.000Z", data: {}
  })}\n\n`;
const wireTerminal = (status, lastSeq) =>
  `event: run-terminal\ndata: ${JSON.stringify({ runId: "run_1", status, lastSeq })}\n\n`;
const wireReady = `event: ready\ndata: {"runId":"run_1","count":2,"lastSeq":1}\n\n`;

function scriptedFetch(connections) {
  let index = 0;
  const encoder = new TextEncoder();
  return async () => {
    const connection = connections[Math.min(index, connections.length - 1)];
    index += 1;
    if (connection.status && connection.status !== 200) {
      return { ok: false, status: connection.status, json: async () => ({ error: connection.error || "nope" }) };
    }
    const chunks = [...(connection.body || [])];
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => (chunks.length ? { done: false, value: encoder.encode(chunks.shift()) } : { done: true }),
          releaseLock: () => {}
        }),
        cancel: async () => {}
      }
    };
  };
}

describe("followRun envelopes and exit codes", () => {
  it("maps run statuses to exit codes", () => {
    assert.equal(exitCodeForRunStatus("succeeded"), 0);
    for (const status of ["failed", "cancelled", "timed_out", "budget_exceeded", "invalid_output"]) {
      assert.equal(exitCodeForRunStatus(status), 1);
    }
  });

  it("builds stable envelopes", () => {
    const envelope = followEventEnvelope({
      id: "evt_1", runId: "run_1", seq: 4, type: "log", message: "hi", createdAt: "t", data: { a: 1 }
    });
    assert.deepEqual(envelope, {
      kind: "event", runId: "run_1", seq: 4, id: "evt_1", type: "log", message: "hi", createdAt: "t", data: { a: 1 }
    });
    const terminal = followTerminalEnvelope({ runId: "run_1", status: "failed", run: { error: "boom" }, links: { statusUrl: "/api/runs/run_1" } });
    assert.equal(terminal.kind, "terminal");
    assert.equal(terminal.exitCode, 1);
    assert.equal(terminal.error, "boom");
  });

  it("streams NDJSON envelopes to stdout only; diagnostics to stderr; exit 0 on success", async () => {
    const out = sink();
    const err = sink();
    const result = await followRun({
      baseUrl: "http://hub",
      token: "t",
      runId: "run_1",
      json: true,
      out,
      err,
      fetchImpl: scriptedFetch([{ body: [wireReady, wireEvent(0), wireEvent(1), wireTerminal("succeeded", 1)] }]),
      getRunDetail: async () => ({ run: { id: "run_1", status: "succeeded", output: { ok: true } } })
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "succeeded");
    const lines = out.lines().map((line) => JSON.parse(line)); // every stdout line is valid JSON
    assert.deepEqual(lines.map((line) => line.kind), ["event", "event", "terminal"]);
    assert.equal(lines[2].exitCode, 0);
    assert.deepEqual(lines[2].output, { ok: true });
    assert.match(lines[2].links.eventsStreamUrl, /\/events\/stream$/);
    assert.match(err.text(), /attached to run run_1/);
    assert.ok(!out.text().includes("attached to run"), "prose never lands on stdout in json mode");
  });

  it("writes human lines in text mode and a terminal summary; exit 1 on failed terminal", async () => {
    const out = sink();
    const err = sink();
    const result = await followRun({
      baseUrl: "http://hub",
      token: "t",
      runId: "run_1",
      json: false,
      out,
      err,
      fetchImpl: scriptedFetch([{ body: [wireReady, wireEvent(0, "runner.started", "Executing"), wireTerminal("failed", 0)] }]),
      getRunDetail: async () => ({ run: { id: "run_1", status: "failed", error: "engine exploded" } })
    });
    assert.equal(result.exitCode, 1);
    assert.match(out.text(), /\[2026-07-23T00:00:00\.000Z\] runner\.started: Executing/);
    assert.match(out.text(), /Run run_1 finished: failed/);
    assert.match(out.text(), /engine exploded/);
  });

  it("exits 4 on auth failure and 3 on transport exhaustion", async () => {
    const auth = await followRun({
      baseUrl: "http://hub", token: "bad", runId: "run_1", json: true,
      out: sink(), err: sink(),
      fetchImpl: scriptedFetch([{ status: 401 }])
    });
    assert.equal(auth.exitCode, FOLLOW_EXIT.AUTH);

    const transport = await followRun({
      baseUrl: "http://hub", token: "t", runId: "run_1", json: true,
      out: sink(), err: sink(),
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
      maxConsecutiveFailures: 2,
      backoff: { baseMs: 1, maxMs: 1, jitter: 0 }
    });
    assert.equal(transport.exitCode, FOLLOW_EXIT.TRANSPORT);
  });

  it("exits 2 for an unknown run", async () => {
    const result = await followRun({
      baseUrl: "http://hub", token: "t", runId: "run_missing", json: true,
      out: sink(), err: sink(),
      fetchImpl: scriptedFetch([{ status: 404, error: "run not found" }])
    });
    assert.equal(result.exitCode, FOLLOW_EXIT.USAGE);
  });

  it("resumes across a drop without duplicating events on stdout", async () => {
    const out = sink();
    const result = await followRun({
      baseUrl: "http://hub", token: "t", runId: "run_1", json: true,
      out, err: sink(),
      backoff: { baseMs: 1, maxMs: 2, jitter: 0 },
      fetchImpl: scriptedFetch([
        { body: [wireReady, wireEvent(0), wireEvent(1)] }, // silent drop
        { body: [wireReady, wireEvent(0), wireEvent(1), wireEvent(2), wireTerminal("succeeded", 2)] }
      ])
    });
    assert.equal(result.exitCode, 0);
    const seqs = out.lines().map((line) => JSON.parse(line)).filter((line) => line.kind === "event").map((line) => line.seq);
    assert.deepEqual(seqs, [0, 1, 2]);
  });
});

// --- Process-level: the real CLI against a stub hub --------------------------

function stubHub({ streamBody, keepOpen = false, runStatus = "succeeded" }) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url.match(/^\/api\/runs\/[^/]+\/events\/stream/)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(streamBody);
      if (!keepOpen) res.end();
      return;
    }
    if (req.url.match(/^\/api\/runs\/[^/]+$/) && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run: { id: "run_1", status: runStatus, output: { done: true } } }));
      return;
    }
    if (req.url.match(/^\/api\/workflows\/[^/]+\/run$/) && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run: { id: "run_1", status: "queued", capabilityName: "Hello" }, statusUrl: "/api/runs/run_1", eventsStreamUrl: "/api/runs/run_1/events/stream" }));
      return;
    }
    if (req.url.match(/\/cancel$/)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function runCli(args, { url }) {
  const child = spawn(process.execPath, ["src/cli.js", "--url", url, "--token", "tok", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: process.env.HOME },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }) };
}

describe("cli follow process behavior", () => {
  it("logs --follow --json emits pure NDJSON and exits with the run's terminal code", async () => {
    const hub = await stubHub({ streamBody: `${wireReady}${wireEvent(0)}${wireEvent(1)}${wireTerminal("succeeded", 1)}` });
    try {
      const { child, output } = runCli(["--json", "logs", "run_1", "--follow"], hub);
      const [code] = await once(child, "exit");
      const { stdout, stderr } = output();
      assert.equal(code, 0, `stderr was: ${stderr}`);
      const lines = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((line) => line.kind), ["event", "event", "terminal"]);
      assert.match(stderr, /attached to run run_1/);
    } finally {
      hub.server.close();
    }
  });

  it("run --stream-logs (alias) creates the run, follows it, and exits 1 on failure", async () => {
    const hub = await stubHub({
      streamBody: `${wireReady}${wireEvent(0)}${wireTerminal("failed", 0)}`,
      runStatus: "failed"
    });
    try {
      const { child, output } = runCli(["--json", "run", "hello", "--stream-logs"], hub);
      const [code] = await once(child, "exit");
      const { stdout } = output();
      assert.equal(code, 1);
      const lines = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(lines[0].kind, "run-created");
      assert.equal(lines[0].runId, "run_1");
      assert.equal(lines.at(-1).kind, "terminal");
      assert.equal(lines.at(-1).status, "failed");
      assert.ok(hub.calls.some((call) => call.startsWith("POST /api/workflows/hello/run")));
    } finally {
      hub.server.close();
    }
  });

  it("Ctrl-C detaches with exit 130 and never cancels the remote run", async () => {
    const hub = await stubHub({ streamBody: `${wireReady}${wireEvent(0)}`, keepOpen: true });
    try {
      const { child, output } = runCli(["--json", "logs", "run_1", "--follow"], hub);
      // Wait until the first event reached stdout, then interrupt.
      const deadline = Date.now() + 5000;
      while (!output().stdout.includes('"seq":0') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(output().stdout.includes('"seq":0'), "follow attached and streamed before SIGINT");
      child.kill("SIGINT");
      const [code, signal] = await once(child, "exit");
      assert.ok(code === 130 || signal === "SIGINT", `expected detach exit 130, got code=${code} signal=${signal}`);
      assert.equal(code, 130);
      assert.match(output().stderr, /detached from run run_1/);
      assert.ok(!hub.calls.some((call) => call.includes("/cancel")), "detach must not cancel the run");
    } finally {
      hub.server.close();
    }
  });
});
