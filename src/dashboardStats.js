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
