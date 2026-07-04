import { deepLinks } from "../lib/router.js";
import { approvalWorkflowLabel } from "../lib/runHelpers.js";
import { resolveApproval } from "../lib/approvalActions.js";
import { StatusBadge, ShareButton } from "./ui.jsx";

// Pending/recent approvals list. Ported from approvalList(). Reused by the
// Home view's "Pending approvals" section and (later) the Approvals view.
export function ApprovalList({ approvals = [] }) {
  if (!approvals.length) {
    return (
      <div className="empty">
        <p className="empty-runs-headline">No pending approvals</p>
        <p className="muted">
          You're all caught up. When a workflow pauses for human sign-off it lands here with full context and Approve / Reject controls.
        </p>
      </div>
    );
  }
  return (
    <div className="approval-list">
      {approvals.map((approval) => (
        <article className="item approval-card" id={`approval-${approval.id}`} key={approval.id}>
          <header className="approval-card-head">
            <StatusBadge value={approval.status} />
            {approval.timerState === "fallback_required" ? (
              <span className="chip chip-version" title="The approval timer elapsed with no configured fallback. The run is held (not failed) until a human decides.">
                ⏳ needs fallback decision
              </span>
            ) : null}
            <span className="muted">{approvalWorkflowLabel(approval)}</span>
            <ShareButton hash={deepLinks.approval(approval.id)} label="Copy share link to this approval" />
          </header>
          <h3><a href={deepLinks.approval(approval.id)}>{approval.title}</a></h3>
          <p className="muted approval-card-desc">{approval.description || "No description provided."}</p>
          <p className="muted approval-card-meta">{approval.runId || "No linked run"}</p>
          <div className="toolbar-actions">
            <a className="button" href={deepLinks.approval(approval.id)}>Open approval</a>
            {approval.status === "pending" ? (
              <>
                <button className="primary" onClick={() => resolveApproval(approval.id, "approve")}>Approve</button>
                <button className="danger" onClick={() => resolveApproval(approval.id, "reject")}>Reject</button>
              </>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}
