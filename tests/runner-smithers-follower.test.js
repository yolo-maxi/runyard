// Runner incremental Smithers event follower: chunked NDJSON parsing,
// ordered serialized delivery, restart-with-dedupe, terminal completion,
// give-up fallback, and kill-on-stop (no leaked children).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createSmithersEventFollower,
  smithersFollowerArgs
} from "../src/runnerSmithersFollower.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.exitCode === null) this.exit(signal === "SIGKILL" ? 137 : 143);
  }

  write(text) {
    this.stdout.emit("data", Buffer.from(text));
  }

  exit(code) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code);
  }
}

const line = (seq, type = "NodeStarted") =>
  `${JSON.stringify({ runId: "run-smithers", seq, timestampMs: 1000 + seq, type, payload: { nodeId: `n${seq}` } })}\n`;

function harness(options = {}) {
  const children = [];
  const delivered = [];
  const errors = [];
  const follower = createSmithersEventFollower({
    spawnFollower: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    onLine: options.onLine || (async (raw, parsed) => {
      if (options.deliveryDelayMs) await new Promise((resolve) => setTimeout(resolve, options.deliveryDelayMs));
      delivered.push(parsed.seq);
    }),
    logError: (message) => errors.push(message),
    backoffDelayMs: () => 1,
    healthyAfterMs: options.healthyAfterMs ?? 60_000,
    maxConsecutiveFailures: options.maxConsecutiveFailures ?? 10,
    killGraceMs: 50
  });
  return { follower, children, delivered, errors };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("smithers event follower", () => {
  it("builds the watch command args (incremental follow, full backlog)", () => {
    assert.deepEqual(
      smithersFollowerArgs("run-123"),
      ["events", "run-123", "--json", "--watch", "--interval", "1", "--limit", "100000"]
    );
  });

  it("parses lines across chunk boundaries, in order, with serialized delivery", async () => {
    const { follower, children, delivered } = harness({ deliveryDelayMs: 5 });
    follower.start();
    const [child] = children;
    const wire = line(0) + line(1) + line(2);
    // Feed byte-by-byte-ish chunks to prove boundary safety.
    child.write(wire.slice(0, 15));
    child.write(wire.slice(15, 40));
    child.write(wire.slice(40));
    await follower.waitForIdle();
    assert.deepEqual(delivered, [0, 1, 2]);
    assert.equal(follower.lines.length, 3);
    assert.equal(follower.lastSeq(), 2);
    await follower.stop();
  });

  it("dedupes the replayed backlog after a crash restart — no repeated posts", async () => {
    const { follower, children, delivered } = harness();
    follower.start();
    children[0].write(line(0) + line(1));
    await follower.waitForIdle();
    children[0].exit(1); // crash
    await tick(20); // restart backoff
    assert.equal(children.length, 2, "respawned after crash");
    children[1].write(line(0) + line(1) + line(2)); // watch replays backlog
    await follower.waitForIdle();
    assert.deepEqual(delivered, [0, 1, 2], "already-posted seqs dropped");
    assert.equal(follower.lines.length, 3);
    await follower.stop();
  });

  it("treats a clean exit 0 as engine-terminal completion and does not restart", async () => {
    const { follower, children } = harness();
    follower.start();
    children[0].write(line(0));
    children[0].exit(0);
    assert.equal(await follower.waitForExit(500), true);
    assert.equal(follower.isCompleted(), true);
    await tick(20);
    assert.equal(children.length, 1, "no respawn after clean terminal exit");
    await follower.stop();
  });

  it("restarts on a zero exit when the engine run is still live (external signal)", async () => {
    const children = [];
    const delivered = [];
    let terminal = false;
    const follower = createSmithersEventFollower({
      spawnFollower: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      onLine: async (raw, parsed) => delivered.push(parsed.seq),
      logError: () => {},
      backoffDelayMs: () => 1,
      isEngineTerminal: async () => terminal
    });
    follower.start();
    children[0].write(line(0));
    children[0].exit(0); // externally signalled mid-run — NOT a real drain
    await tick(20);
    assert.equal(follower.isCompleted(), false, "zero exit not trusted while engine live");
    assert.equal(children.length, 2, "follower restarted");
    terminal = true;
    children[1].write(line(0) + line(1));
    children[1].exit(0);
    assert.equal(await follower.waitForExit(500), true);
    assert.equal(follower.isCompleted(), true);
    await follower.waitForIdle();
    assert.deepEqual(delivered, [0, 1], "replayed backlog deduped across the restart");
    await follower.stop();
  });

  it("processes a final unterminated line at exit", async () => {
    const { follower, children, delivered } = harness();
    follower.start();
    children[0].write(line(0) + JSON.stringify({ runId: "run-smithers", seq: 1, timestampMs: 1001, type: "X", payload: {} }));
    children[0].exit(0);
    await follower.waitForExit(500);
    await follower.waitForIdle();
    assert.deepEqual(delivered, [0, 1]);
    await follower.stop();
  });

  it("skips non-JSON noise without posting it", async () => {
    const { follower, children, delivered, errors } = harness();
    follower.start();
    children[0].write(`not json at all\n${line(0)}`);
    await follower.waitForIdle();
    assert.deepEqual(delivered, [0]);
    assert.ok(errors.some((message) => message.includes("non-JSON")));
    await follower.stop();
  });

  it("gives up after maxConsecutiveFailures and reports it", async () => {
    const { follower, children, errors } = harness({ maxConsecutiveFailures: 3 });
    follower.start();
    children[0].exit(1);
    await tick(15);
    children[1]?.exit(1);
    await tick(15);
    children[2]?.exit(1);
    await tick(15);
    assert.equal(children.length, 3);
    assert.equal(follower.isGivenUp(), true);
    assert.ok(errors.some((message) => message.includes("gave up")));
    await follower.stop();
  });

  it("stop() kills the live child and suppresses restarts — no zombies", async () => {
    const { follower, children } = harness();
    follower.start();
    children[0].write(line(0));
    await follower.waitForIdle();
    await follower.stop();
    assert.deepEqual(children[0].kills, ["SIGTERM"]);
    assert.notEqual(children[0].exitCode, null, "child actually exited");
    await tick(20);
    assert.equal(children.length, 1, "no respawn after stop");
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const children = [];
    const follower = createSmithersEventFollower({
      spawnFollower: () => {
        const child = new FakeChild();
        // Ignore SIGTERM; only die on SIGKILL.
        child.kill = (signal) => {
          child.kills.push(signal);
          if (signal === "SIGKILL") child.exit(137);
        };
        children.push(child);
        return child;
      },
      onLine: async () => {},
      logError: () => {},
      killGraceMs: 20
    });
    follower.start();
    await follower.stop();
    assert.deepEqual(children[0].kills, ["SIGTERM", "SIGKILL"]);
    assert.equal(children[0].exitCode, 137);
  });

  it("keeps delivering in order even when onLine posts are slow (Hub post ordering)", async () => {
    const order = [];
    const { follower, children } = harness({
      onLine: async (raw, parsed) => {
        // Later events must wait for earlier posts, even when earlier are slower.
        await new Promise((resolve) => setTimeout(resolve, parsed.seq === 0 ? 20 : 1));
        order.push(parsed.seq);
      }
    });
    follower.start();
    children[0].write(line(0) + line(1) + line(2));
    await follower.waitForIdle();
    assert.deepEqual(order, [0, 1, 2]);
    await follower.stop();
  });
});
