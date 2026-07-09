import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyDashboardPoolStats,
  dashboardCountQuery,
  DASHBOARD_COUNT_TABLES,
  normalizeUsageTotalsRow,
  pendingApprovalsCountQuery,
  runningRunsCountQuery,
  usageTotalsQuery
} from "../src/dashboardStats.js";

describe("dashboard stats helpers", () => {
  it("declares the dashboard count tables in display payload order", () => {
    assert.deepEqual(DASHBOARD_COUNT_TABLES, [
      "capabilities",
      "agents",
      "skills",
      "knowledge_resources",
      "runners",
      "runs",
      "artifacts",
      "approvals"
    ]);
  });

  it("builds count queries and applies the visible-runs filter only to runs", () => {
    assert.deepEqual(dashboardCountQuery("runs", "visible = 1"), {
      key: "runs",
      sql: "SELECT COUNT(*) AS count FROM runs WHERE visible = 1",
      params: []
    });
    assert.deepEqual(dashboardCountQuery("agents", "visible = 1"), {
      key: "agents",
      sql: "SELECT COUNT(*) AS count FROM agents",
      params: []
    });
    assert.deepEqual(pendingApprovalsCountQuery(), {
      key: "pendingApprovals",
      sql: "SELECT COUNT(*) AS count FROM approvals WHERE status='pending'",
      params: []
    });
    assert.deepEqual(runningRunsCountQuery("visible = 1"), {
      key: "runningRuns",
      sql: "SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'assigned', 'running', 'waiting_approval', 'paused') AND visible = 1",
      params: []
    });
  });

  it("sums metered usage across visible runs and normalizes empty totals", () => {
    const query = usageTotalsQuery("visible = 1");
    assert.equal(query.key, "usage");
    assert.match(query.sql, /json_extract\(usage, '\$\.totalTokens'\)/);
    assert.match(query.sql, /usage IS NOT NULL AND visible = 1/);
    assert.deepEqual(normalizeUsageTotalsRow({ total_tokens: 100, cost_micros: 5, calls: 2, metered_runs: 1 }), {
      totalTokens: 100,
      costMicros: 5,
      calls: 2,
      meteredRuns: 1
    });
    assert.deepEqual(normalizeUsageTotalsRow({}), { totalTokens: 0, costMicros: 0, calls: 0, meteredRuns: 0 });
  });

  it("maps runner pool stats into dashboard field names", () => {
    assert.deepEqual(applyDashboardPoolStats({
      runs: 4,
      pendingApprovals: 1
    }, {
      queued: 2,
      assigned: 1,
      running: 3,
      waitingApproval: 4,
      onlineRunners: 5,
      totalCapacity: 6,
      totalActive: 7,
      availableSlots: 8
    }), {
      runs: 4,
      pendingApprovals: 1,
      queuedRuns: 2,
      assignedRuns: 1,
      activeRuns: 3,
      waitingApprovalRuns: 4,
      onlineRunners: 5,
      runnerCapacity: 6,
      runnerActiveSlots: 7,
      runnerAvailableSlots: 8
    });
  });
});
