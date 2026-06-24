import { useLiveQuery } from "@tanstack/react-db";
import { runsCollection, approvalsCollection, runnersCollection } from "./collections.js";
import { isUnresolvedFailure } from "./runHelpers.js";

// Derived sidebar/nav badge counts — replaces the legacy 30s refreshSidebarBadges
// setInterval loop with a reactive live query over the runs/approvals/runners
// collections. Counts update automatically as those collections refetch.
export function useSidebarBadges() {
  const { data: runs = [] } = useLiveQuery((q) => runsCollection);
  const { data: approvals = [] } = useLiveQuery((q) => approvalsCollection);
  const { data: runners = [] } = useLiveQuery((q) => runnersCollection);

  const cutoff = Date.now() - 24 * 3600 * 1000;
  const failedRuns = runs.filter((r) => {
    if (!isUnresolvedFailure(r)) return false;
    const t = Date.parse(r.completedAt || r.createdAt || "");
    return Number.isNaN(t) ? true : t >= cutoff;
  }).length;
  const pendingApprovals = approvals.filter((a) => a.status === "pending").length;
  const offlineRunners = runners.filter((r) => !r.online).length;

  return { runs: failedRuns, approvals: pendingApprovals, runners: offlineRunners };
}
