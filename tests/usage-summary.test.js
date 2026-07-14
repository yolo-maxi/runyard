import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeUsageSummaryTotals,
  normalizeUsageSummaryWorkflowRow,
  USAGE_SUMMARY_DEFAULT_DAYS,
  USAGE_SUMMARY_MAX_DAYS,
  usageSummaryByWorkflowQuery,
  usageSummaryBudgetStopsQuery,
  usageSummaryDays,
  usageSummaryTotalsQuery
} from "../src/usageSummary.js";
import { createRunReadHandlers } from "../src/runReadRoutes.js";
import { mockResponse as response } from "./response.js";

describe("usageSummaryDays", () => {
  it("defaults and clamps the window", () => {
    assert.equal(usageSummaryDays(undefined), USAGE_SUMMARY_DEFAULT_DAYS);
    assert.equal(usageSummaryDays(""), USAGE_SUMMARY_DEFAULT_DAYS);
    assert.equal(usageSummaryDays("nope"), USAGE_SUMMARY_DEFAULT_DAYS);
    assert.equal(usageSummaryDays(-3), USAGE_SUMMARY_DEFAULT_DAYS);
    assert.equal(usageSummaryDays(0.4), 1);
    assert.equal(usageSummaryDays(7), 7);
    assert.equal(usageSummaryDays("14.9"), 14);
    assert.equal(usageSummaryDays(100000), USAGE_SUMMARY_MAX_DAYS);
  });
});

describe("usage summary queries", () => {
  const visible = "NOT (hidden = 1)";

  it("scope every query to metered/visible runs and the window", () => {
    for (const query of [usageSummaryTotalsQuery(visible), usageSummaryByWorkflowQuery(visible)]) {
      assert.match(query.sql, /usage IS NOT NULL/);
      assert.match(query.sql, /created_at >= \?/);
      assert.ok(query.sql.includes(visible));
    }
    const stops = usageSummaryBudgetStopsQuery(visible);
    assert.match(stops.sql, /status = 'budget_exceeded'/);
    assert.match(stops.sql, /created_at >= \?/);
    assert.ok(stops.sql.includes(visible));
  });

  it("groups the workflow breakdown by slug, highest spend first", () => {
    const query = usageSummaryByWorkflowQuery(visible);
    assert.match(query.sql, /GROUP BY capability_slug/);
    assert.match(query.sql, /ORDER BY cost_micros DESC, total_tokens DESC/);
  });

  it("normalizes totals and workflow rows to camelCase numbers", () => {
    assert.deepEqual(normalizeUsageSummaryTotals({ total_tokens: "120", cost_micros: 42, calls: 3, metered_runs: 2 }), {
      totalTokens: 120,
      costMicros: 42,
      calls: 3,
      meteredRuns: 2
    });
    assert.deepEqual(normalizeUsageSummaryTotals({}), { totalTokens: 0, costMicros: 0, calls: 0, meteredRuns: 0 });
    const row = normalizeUsageSummaryWorkflowRow({
      capability_slug: "research",
      capability_name: "Research",
      total_tokens: 10,
      cost_micros: 5,
      calls: 1,
      metered_runs: 1,
      last_run_at: "2026-07-13T00:00:00.000Z"
    });
    assert.equal(row.workflow, "research");
    assert.equal(row.name, "Research");
    assert.equal(row.totalTokens, 10);
    assert.equal(row.lastRunAt, "2026-07-13T00:00:00.000Z");
  });
});

describe("GET /api/usage/summary handler", () => {
  it("computes the window and merges the db rollup", () => {
    const calls = [];
    const handlers = createRunReadHandlers({
      usageSummary: ({ since }) => {
        calls.push(since);
        return {
          totals: { totalTokens: 100, costMicros: 7, calls: 2, meteredRuns: 1 },
          byWorkflow: [{ workflow: "research" }],
          budgetStopped: 1
        };
      }
    });
    const res = response();
    handlers.getUsageSummary({ query: { days: "7" } }, res);
    assert.equal(res.body.window.days, 7);
    assert.equal(res.body.window.since, calls[0]);
    const ageMs = Date.now() - Date.parse(res.body.window.since);
    assert.ok(Math.abs(ageMs - 7 * 24 * 60 * 60 * 1000) < 5000, `since should be ~7 days ago (got ${res.body.window.since})`);
    assert.equal(res.body.totals.totalTokens, 100);
    assert.equal(res.body.byWorkflow.length, 1);
    assert.equal(res.body.budgetStopped, 1);
  });
});

describe("GET /api/runs/attention handler", () => {
  it("collects paused, waiting-approval, and recent budget-stopped runs with counts", () => {
    const listCalls = [];
    const handlers = createRunReadHandlers({
      countPendingApprovals: () => 4,
      listRuns: (options) => {
        listCalls.push(options);
        if (options.status === "paused") return [{ id: "run_p", status: "paused" }];
        if (options.status === "waiting_approval") return [{ id: "run_w", status: "waiting_approval" }];
        if (options.status === "budget_exceeded") return [{ id: "run_b", status: "budget_exceeded" }];
        return [];
      },
      withRunLinks: (run) => ({ ...run, linked: true })
    });
    const res = response();
    handlers.listAttentionRuns({}, res);
    assert.deepEqual(res.body.counts, { paused: 1, waitingApproval: 1, budgetStopped: 1, pendingApprovals: 4 });
    assert.equal(res.body.attention.paused[0].linked, true);
    assert.equal(res.body.attention.budgetStopped[0].id, "run_b");
    const budgetCall = listCalls.find((options) => options.status === "budget_exceeded");
    const windowMs = Date.now() - Date.parse(budgetCall.since);
    assert.ok(Math.abs(windowMs - 7 * 24 * 60 * 60 * 1000) < 5000, "budget stops look back 7 days");
    assert.ok(typeof res.body.generatedAt === "string" && res.body.generatedAt.includes("T"));
  });
});
