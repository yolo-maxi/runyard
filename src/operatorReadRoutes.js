import { buildRepoCatalog } from "./repoCatalog.js";
import { buildQueueIndex } from "./runPresentation.js";

export function dashboardPayload({
  dashboardStats,
  listApprovals,
  listRuns,
  runnerPoolStats,
  withApprovalLinks,
  withRunLinks
} = {}) {
  const recent = listRuns({ limit: 8 });
  const queueIndex = buildQueueIndex(listRuns({ status: "queued", limit: 500 }));
  return {
    stats: dashboardStats(),
    pool: runnerPoolStats(),
    recentRuns: recent.map((run) => withRunLinks(run, queueIndex)),
    pendingApprovals: listApprovals("pending").map(withApprovalLinks)
  };
}

export function createOperatorReadHandlers({
  dashboardStats,
  env = process.env,
  listApprovals,
  listRuns,
  runnerPoolStats,
  withApprovalLinks,
  withRunLinks
} = {}) {
  const dashboardDeps = {
    dashboardStats,
    listApprovals,
    listRuns,
    runnerPoolStats,
    withApprovalLinks,
    withRunLinks
  };

  return {
    dashboard(_req, res) {
      res.json(dashboardPayload(dashboardDeps));
    },

    repoOptions(_req, res) {
      // The catalog helper owns all sanitization: friendly selector keys only,
      // no runner-local path scans or secret material in API responses.
      res.json(buildRepoCatalog(env));
    }
  };
}
