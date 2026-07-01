import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_RUNNER_CAPACITY,
  clampActiveRuns,
  normalizeRunnerCapacity,
  runnerHealthSummary,
  supervisorPoolSizeForCapacity
} from "../src/runnerPoolPolicy.js";

describe("runner pool policy helpers", () => {
  it("normalizes runner capacity with a conservative upper bound", () => {
    assert.equal(normalizeRunnerCapacity("4.9"), 4);
    assert.equal(normalizeRunnerCapacity("0", 2), 2);
    assert.equal(normalizeRunnerCapacity("bad", 3), 3);
    assert.equal(normalizeRunnerCapacity("999"), MAX_RUNNER_CAPACITY);
  });

  it("clamps display active-runs into the runner capacity", () => {
    assert.equal(clampActiveRuns(-2, 4), 0);
    assert.equal(clampActiveRuns(2, 4), 2);
    assert.equal(clampActiveRuns(9, 4), 4);
  });

  it("sizes supervisor pools separately from work capacity", () => {
    assert.equal(supervisorPoolSizeForCapacity(1, 1), 1);
    assert.equal(supervisorPoolSizeForCapacity(4, 0.5), 2);
    assert.equal(supervisorPoolSizeForCapacity("bad", 2), 2);
  });

  it("summarizes runner health from liveness, capacity pressure, and auth", () => {
    assert.deepEqual(runnerHealthSummary({
      live: true,
      capacity: 4,
      load: { work: 1 },
      authHealth: { hub: { ok: true } }
    }), { score: 100, state: "healthy", issues: [] });

    const degraded = runnerHealthSummary({
      live: true,
      capacity: 2,
      load: { work: 2 },
      authHealth: { claude: { ok: false, error: "expired" } }
    });
    assert.equal(degraded.state, "degraded");
    assert.deepEqual(degraded.issues, ["work pool full", "claude auth: expired"]);

    const offline = runnerHealthSummary({
      live: false,
      capacity: 1,
      load: { work: 0 },
      authHealth: { hub: { ok: false, error: "unauthorized" } }
    });
    assert.equal(offline.state, "offline");
    assert.ok(offline.issues.includes("offline"));
    assert.ok(offline.issues.includes("hub auth: unauthorized"));
  });
});
