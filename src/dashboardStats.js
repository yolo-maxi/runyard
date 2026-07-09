export const DASHBOARD_COUNT_TABLES = [
  "capabilities",
  "agents",
  "skills",
  "knowledge_resources",
  "runners",
  "runs",
  "artifacts",
  "approvals"
];

export function dashboardCountQuery(table, visibleRunWhere) {
  if (table === "runs") {
    return {
      key: table,
      sql: `SELECT COUNT(*) AS count FROM runs WHERE ${visibleRunWhere}`,
      params: []
    };
  }
  return {
    key: table,
    sql: `SELECT COUNT(*) AS count FROM ${table}`,
    params: []
  };
}

export function pendingApprovalsCountQuery() {
  return {
    key: "pendingApprovals",
    sql: "SELECT COUNT(*) AS count FROM approvals WHERE status='pending'",
    params: []
  };
}

export function runningRunsCountQuery(visibleRunWhere) {
  return {
    key: "runningRuns",
    sql: `SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued', 'assigned', 'running', 'waiting_approval') AND ${visibleRunWhere}`,
    params: []
  };
}

// Fleet-wide metered usage rolled up from the per-run aggregates. Costs are
// summed only where a record carried/estimated one, so this is a floor.
export function usageTotalsQuery(visibleRunWhere) {
  return {
    key: "usage",
    sql: `SELECT
        COALESCE(SUM(json_extract(usage, '$.totalTokens')), 0) AS total_tokens,
        COALESCE(SUM(json_extract(usage, '$.costMicros')), 0) AS cost_micros,
        COALESCE(SUM(json_extract(usage, '$.calls')), 0) AS calls,
        COUNT(*) AS metered_runs
      FROM runs WHERE usage IS NOT NULL AND ${visibleRunWhere}`,
    params: []
  };
}

export function normalizeUsageTotalsRow(row = {}) {
  return {
    totalTokens: Number(row.total_tokens) || 0,
    costMicros: Number(row.cost_micros) || 0,
    calls: Number(row.calls) || 0,
    meteredRuns: Number(row.metered_runs) || 0
  };
}

export function applyDashboardPoolStats(counts = {}, pool = {}) {
  return {
    ...counts,
    queuedRuns: pool.queued,
    assignedRuns: pool.assigned,
    activeRuns: pool.running,
    waitingApprovalRuns: pool.waitingApproval,
    onlineRunners: pool.onlineRunners,
    runnerCapacity: pool.totalCapacity,
    runnerActiveSlots: pool.totalActive,
    runnerAvailableSlots: pool.availableSlots
  };
}
