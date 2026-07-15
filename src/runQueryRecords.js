export function buildRunFilterClause({
  status = "",
  q = "",
  since = "",
  until = "",
  cursor = "",
  capabilitySlugs = [],
  workItemId = "",
  includeInternal = false,
  visibleRunWhere = ""
} = {}) {
  const where = [];
  const params = [];
  if (!includeInternal && visibleRunWhere) {
    where.push(visibleRunWhere);
  }
  if (workItemId) {
    where.push("work_item_id = ?");
    params.push(workItemId);
  }
  const slugs = Array.isArray(capabilitySlugs)
    ? [...new Set(capabilitySlugs.map((slug) => String(slug || "").trim()).filter(Boolean))]
    : [];
  if (slugs.length) {
    where.push(`capability_slug IN (${slugs.map(() => "?").join(", ")})`);
    params.push(...slugs);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (since) {
    where.push("created_at >= ?");
    params.push(since);
  }
  if (until) {
    where.push("created_at <= ?");
    params.push(until);
  }
  if (cursor) {
    where.push("created_at < ?");
    params.push(cursor);
  }
  if (q) {
    // Plain substring match across the columns operators search by. Strip
    // wildcard characters so typing '%' or '_' cannot change search meaning.
    where.push("(capability_name LIKE ? OR capability_slug LIKE ? OR id LIKE ? OR current_step LIKE ? OR COALESCE(error,'') LIKE ?)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    params.push(like, like, like, like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function runListQuery(filters = {}) {
  const limit = filters.limit ?? 100;
  const { clause, params } = buildRunFilterClause(filters);
  return {
    sql: `SELECT * FROM runs ${clause} ORDER BY created_at DESC LIMIT ?`,
    params: [...params, limit]
  };
}

export function runCountQuery(filters = {}) {
  const { clause, params } = buildRunFilterClause(filters);
  return {
    sql: `SELECT COUNT(*) AS count FROM runs ${clause}`,
    params
  };
}

export function capabilityVersionsFromRunsQuery(slug) {
  return {
    sql: `SELECT capability_sha AS sha,
            COUNT(*) AS runCount,
            MIN(created_at) AS firstSeenAt,
            MAX(created_at) AS lastSeenAt
       FROM runs
      WHERE capability_slug = ?
        AND capability_sha IS NOT NULL
        AND capability_sha <> ''
      GROUP BY capability_sha
      ORDER BY lastSeenAt DESC`,
    params: [slug]
  };
}

export function normalizeCapabilityVersionFromRun(row) {
  return {
    sha: row.sha,
    runCount: row.runCount,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt
  };
}

export function ageMs(timestamp, nowMs = Date.now()) {
  if (!timestamp) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return nowMs - parsed;
}

export function runBackstopExceeded(row, maxMs, nowMs) {
  if (!maxMs || maxMs <= 0) return false;
  const started = row.started_at || row.assigned_at || row.created_at;
  return ageMs(started, nowMs) > maxMs;
}

export function runReapReason(row, {
  maxMs = 0,
  stallMs = 0,
  runnerOfflineMs = 0,
  nowMs = Date.now(),
  hasPendingApproval = () => false,
  hasEngineApprovalWait = () => false
} = {}) {
  if (row.status === "waiting_approval") return null;
  // Paused runs are parked on a recoverable external condition (e.g. credits
  // exhausted) with no runner attached to heartbeat for them. Liveness, stall,
  // and deadline backstops all stand down until an explicit resume or cancel.
  if (row.status === "paused") return null;
  if (row.runner_id && ageMs(row.last_heartbeat_at, nowMs) > runnerOfflineMs) {
    return {
      currentStep: "runner offline",
      error: "runner heartbeat expired",
      message: "Runner stopped heartbeating while the run was active",
      reason: "runner_offline"
    };
  }
  // A run blocked on a pending human decision — its own pending approval card
  // or an engine-level Smithers <Approval> pause the runner surfaced via
  // engine.approval.* events — is never reaped for age. Approvals are blocking
  // by contract: a human being late is a product signal, not a run failure, so
  // neither the stall window nor the max-runtime backstop applies while a
  // decision is pending. A dead runner (heartbeat expired, above) still wins:
  // that is an infra fact, not an approval timeout.
  if (hasPendingApproval(row.id)) return null;
  if (hasEngineApprovalWait(row.id)) return null;
  if (stallMs > 0) {
    const lastEventAt = row.last_event_at || row.started_at || row.assigned_at || row.created_at;
    if (ageMs(lastEventAt, nowMs) > stallMs) {
      return {
        currentStep: "stalled",
        error: "run emitted no events within stall window",
        message: "Run emitted no events within the stall window",
        reason: "run_stalled"
      };
    }
  }
  if (runBackstopExceeded(row, maxMs, nowMs)) {
    return {
      currentStep: "timed out",
      error: "run exceeded execution deadline",
      message: "Run exceeded execution deadline",
      reason: "max_runtime"
    };
  }
  return null;
}
