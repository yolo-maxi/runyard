import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { pauseReasonLabel, truncate } from "../lib/runHelpers.js";
import { resumeRun } from "../lib/runActions.js";

// The operator triage strip above the runs list, backed by
// GET /api/runs/attention: every run whose next step is a human action —
// paused (resume), waiting for approval (decide), or stopped at its budget in
// the last 7 days (raise the budget and re-run). Renders nothing when nothing
// needs a human, so a healthy deployment pays no attention tax.
export function AttentionStrip() {
  const attentionQ = useQuery({
    queryKey: ["runs-attention"],
    queryFn: () => api("/api/runs/attention"),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev
  });
  const counts = attentionQ.data?.counts || {};
  const attention = attentionQ.data?.attention || {};
  const total = (counts.paused || 0) + (counts.waitingApproval || 0) + (counts.budgetStopped || 0);
  if (!total) return null;

  const groups = [
    {
      key: "paused",
      heading: "Paused",
      hint: "Interrupted by a recoverable condition — resume when it's resolved",
      runs: attention.paused || [],
      detail: (run) => pauseReasonLabel(run.pause?.reason),
      action: (run) => run.pause?.resumable !== false
        ? (
          <button
            type="button"
            className="btn-sm primary"
            title={run.pause?.resume?.smithersRunId ? "Resume from the recorded checkpoint" : "Re-queue (no checkpoint recorded, restarts from scratch)"}
            onClick={async () => { await resumeRun(run.id); attentionQ.refetch(); }}
          >
            ▶ Resume
          </button>
        )
        : null
    },
    {
      key: "approval",
      heading: "Waiting for approval",
      hint: "A human decision is pending",
      runs: attention.waitingApproval || [],
      detail: () => "Waiting on an approval card",
      action: () => <a className="btn-sm button" href={deepLinks.approvals()}>Review</a>
    },
    {
      key: "budget",
      heading: "Stopped at budget",
      hint: "Hit their spend ceiling in the last 7 days — raise the budget and re-run to finish",
      runs: attention.budgetStopped || [],
      detail: (run) => truncate(String(run.error || "Reached its spend budget"), 100),
      action: (run) => <a className="btn-sm button" href={deepLinks.run(run.id)}>Inspect</a>
    }
  ].filter((group) => group.runs.length);

  return (
    <section className="attention-strip" aria-label="Runs needing attention">
      <header className="attention-strip-head">
        <strong>Needs attention</strong>
        <span className="muted">{total} run{total === 1 ? "" : "s"} waiting on a human</span>
        {counts.pendingApprovals ? (
          <a className="attention-approvals-link" href={deepLinks.approvals()}>
            {counts.pendingApprovals} approval card{counts.pendingApprovals === 1 ? "" : "s"} pending →
          </a>
        ) : null}
      </header>
      {groups.map((group) => (
        <div className="attention-group" data-attention-group={group.key} key={group.key}>
          <p className="attention-group-heading" title={group.hint}>{group.heading} · {group.runs.length}</p>
          <ul className="attention-run-list">
            {group.runs.slice(0, 5).map((run) => (
              <li className="attention-run" key={run.id}>
                <a className="attention-run-title" href={deepLinks.run(run.id)}>{run.title || run.id}</a>
                <span className="muted attention-run-detail">{group.detail(run)}</span>
                <span className="attention-run-action">{group.action(run)}</span>
              </li>
            ))}
            {group.runs.length > 5 ? (
              <li className="muted attention-run-more">
                <a href={`#runs?status=${group.key === "paused" ? "paused" : group.key === "approval" ? "waiting_approval" : "budget_exceeded"}`}>
                  +{group.runs.length - 5} more
                </a>
              </li>
            ) : null}
          </ul>
        </div>
      ))}
    </section>
  );
}
