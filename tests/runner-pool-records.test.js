import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runnerPoolStatusQueries,
  runnerPoolSummary,
  runStatusCountQuery
} from "../src/runnerPoolRecords.js";

describe("runner pool record helpers", () => {
  it("builds run status count queries", () => {
    assert.deepEqual(runStatusCountQuery("running"), {
      sql: "SELECT COUNT(*) AS count FROM runs WHERE status = ?",
      params: ["running"]
    });
    assert.deepEqual(runStatusCountQuery(["assigned", "running"], { visibleRunWhere: "visible = 1" }), {
      sql: "SELECT COUNT(*) AS count FROM runs WHERE status IN (?,?) AND visible = 1",
      params: ["assigned", "running"]
    });
    assert.throws(() => runStatusCountQuery([]), /at least one run status/);
  });

  it("builds pool status query groups", () => {
    assert.deepEqual(Object.keys(runnerPoolStatusQueries("visible = 1")), [
      "queued",
      "assigned",
      "running",
      "waitingApproval"
    ]);
  });

  it("summarizes normalized runner pool capacity and health", () => {
    assert.deepEqual(runnerPoolSummary({
      counts: { queued: 3, assigned: 2, running: 1, waitingApproval: 4 },
      runners: [
        { online: true, capacity: 3, workRuns: 2, health: { state: "healthy" } },
        { online: true, capacity: 2, workRuns: 0, health: { state: "degraded" } },
        { online: false, capacity: 8, workRuns: 7, health: { state: "offline" } }
      ]
    }), {
      queued: 3,
      assigned: 2,
      running: 1,
      waitingApproval: 4,
      totalCapacity: 5,
      totalActive: 2,
      availableSlots: 3,
      onlineRunners: 2,
      runners: 3,
      unhealthyRunners: 1,
      degradedRunners: 1
    });
  });
});
