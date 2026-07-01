import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createClaimAuthTracker,
  isAuthError
} from "../src/runnerClaimAuth.js";

describe("runner claim auth tracker", () => {
  it("classifies hub auth HTTP failures", () => {
    assert.equal(isAuthError({ status: 401 }), true);
    assert.equal(isAuthError({ status: 403 }), true);
    assert.equal(isAuthError({ status: 500 }), false);
    assert.equal(isAuthError(null), null);
  });

  it("records faults, throttles logs, and reports recovery", () => {
    const logs = [];
    const tracker = createClaimAuthTracker({
      baseUrl: "http://hub",
      log: {
        log: (line) => logs.push(["log", line]),
        error: (line) => logs.push(["error", line])
      }
    });

    assert.deepEqual(tracker.health(), { ok: true });
    tracker.record(false, { status: 403, message: "forbidden" });
    assert.deepEqual(tracker.health(), { ok: false, error: "HTTP 403: forbidden" });
    for (let i = 0; i < 18; i += 1) tracker.record(false, { status: 403, message: "forbidden" });
    assert.equal(logs.filter(([level]) => level === "error").length, 1);
    tracker.record(false, { status: 403, message: "forbidden" });
    assert.equal(logs.filter(([level]) => level === "error").length, 2);

    tracker.record(true);
    assert.deepEqual(tracker.health(), { ok: true });
    assert.equal(logs.at(-1)[0], "log");
    assert.match(logs.at(-1)[1], /recovered/);
  });
});
