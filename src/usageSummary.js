// Cross-run usage/cost rollups for the operator-facing usage summary
// (GET /api/usage/summary). Same floor semantics as the dashboard totals
// (src/dashboardStats.js): costs sum only where a record carried or estimated
// one, and only metered runs (usage IS NOT NULL) contribute rows.
export const USAGE_SUMMARY_DEFAULT_DAYS = 30;
export const USAGE_SUMMARY_MAX_DAYS = 365;
export const USAGE_SUMMARY_WORKFLOW_LIMIT = 50;

// Clamp a caller-supplied ?days= to something sane; anything unparseable
// falls back to the default window.
export function usageSummaryDays(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return USAGE_SUMMARY_DEFAULT_DAYS;
  return Math.min(USAGE_SUMMARY_MAX_DAYS, Math.max(1, Math.floor(num)));
}

export function usageSummaryTotalsQuery(visibleRunWhere) {
  return {
    sql: `SELECT
        COALESCE(SUM(json_extract(usage, '$.totalTokens')), 0) AS total_tokens,
        COALESCE(SUM(json_extract(usage, '$.costMicros')), 0) AS cost_micros,
        COALESCE(SUM(json_extract(usage, '$.calls')), 0) AS calls,
        COUNT(*) AS metered_runs
      FROM runs WHERE usage IS NOT NULL AND created_at >= ? AND ${visibleRunWhere}`
  };
}

export function usageSummaryByWorkflowQuery(visibleRunWhere) {
  return {
    sql: `SELECT
        capability_slug,
        capability_name,
        COALESCE(SUM(json_extract(usage, '$.totalTokens')), 0) AS total_tokens,
        COALESCE(SUM(json_extract(usage, '$.costMicros')), 0) AS cost_micros,
        COALESCE(SUM(json_extract(usage, '$.calls')), 0) AS calls,
        COUNT(*) AS metered_runs,
        MAX(created_at) AS last_run_at
      FROM runs WHERE usage IS NOT NULL AND created_at >= ? AND ${visibleRunWhere}
      GROUP BY capability_slug
      ORDER BY cost_micros DESC, total_tokens DESC
      LIMIT ${USAGE_SUMMARY_WORKFLOW_LIMIT}`
  };
}

export function usageSummaryBudgetStopsQuery(visibleRunWhere) {
  return {
    sql: `SELECT COUNT(*) AS count FROM runs WHERE status = 'budget_exceeded' AND created_at >= ? AND ${visibleRunWhere}`
  };
}

export function normalizeUsageSummaryTotals(row = {}) {
  return {
    totalTokens: Number(row.total_tokens) || 0,
    costMicros: Number(row.cost_micros) || 0,
    calls: Number(row.calls) || 0,
    meteredRuns: Number(row.metered_runs) || 0
  };
}

export function normalizeUsageSummaryWorkflowRow(row = {}) {
  return {
    workflow: row.capability_slug || "",
    name: row.capability_name || row.capability_slug || "",
    ...normalizeUsageSummaryTotals(row),
    lastRunAt: row.last_run_at || null
  };
}
