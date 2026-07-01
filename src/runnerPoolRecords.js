export function runStatusCountQuery(statuses, { visibleRunWhere = "" } = {}) {
  const values = Array.isArray(statuses) ? statuses.filter(Boolean) : [statuses].filter(Boolean);
  if (!values.length) throw new Error("at least one run status is required");
  const statusClause = values.length === 1
    ? "status = ?"
    : `status IN (${values.map(() => "?").join(",")})`;
  const visibilityClause = visibleRunWhere ? ` AND ${visibleRunWhere}` : "";
  return {
    sql: `SELECT COUNT(*) AS count FROM runs WHERE ${statusClause}${visibilityClause}`,
    params: values
  };
}

export function runnerPoolStatusQueries(visibleRunWhere) {
  return {
    queued: runStatusCountQuery("queued", { visibleRunWhere }),
    assigned: runStatusCountQuery("assigned", { visibleRunWhere }),
    running: runStatusCountQuery("running", { visibleRunWhere }),
    waitingApproval: runStatusCountQuery("waiting_approval", { visibleRunWhere })
  };
}

export function runnerPoolSummary({ counts, runners }) {
  const allRunners = Array.isArray(runners) ? runners : [];
  const live = allRunners.filter((runner) => runner.online);
  const totalCapacity = live.reduce((sum, runner) => sum + (runner.capacity || 0), 0);
  const totalActive = live.reduce((sum, runner) => sum + (runner.workRuns || 0), 0);
  const totalSupervisors = live.reduce((sum, runner) => sum + (runner.supervisorRuns || 0), 0);
  const unhealthyRunners = allRunners.filter((runner) => runner.health?.state === "unhealthy" || runner.health?.state === "offline").length;
  const degradedRunners = allRunners.filter((runner) => runner.health?.state === "degraded").length;
  return {
    queued: counts.queued,
    assigned: counts.assigned,
    running: counts.running,
    waitingApproval: counts.waitingApproval,
    totalCapacity,
    totalActive,
    totalSupervisors,
    availableSlots: Math.max(0, totalCapacity - totalActive),
    onlineRunners: live.length,
    runners: allRunners.length,
    unhealthyRunners,
    degradedRunners
  };
}
