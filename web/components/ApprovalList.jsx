import { deepLinks } from "../lib/router.js";
import { approvalWorkflowLabel } from "../lib/runHelpers.js";
import { resolveApproval } from "../lib/approvalActions.js";
import { StatusBadge, ShareButton } from "./ui.jsx";

// Pending/recent approvals list. Ported from approvalList(). Reused by the
// Home view's "Pending approvals" section and (later) the Approvals view.
//
// Each card answers the same questions the detail view does — what happens
// (the ask's action), why, the deadline, the linked run — and offers the same
// three decisions, so deciding from the list is never deciding blind.
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
      {approvals.map((approval) => {
        const context = approval.context || {};
        const contextApproval = context.approval || {};
        const pending = approval.status === "pending";
        return (
          <article className="item approval-card" id={`approval-${approval.id}`} key={approval.id}>
            <header className="approval-card-head">
              <StatusBadge
                value={approval.resolution || approval.status}
                label={pending ? contextApproval.statusLabel || "Pending decision" : contextApproval.resolutionLabel}
              />
              {contextApproval.kindLabel ? <span className="chip">{contextApproval.kindLabel}</span> : null}
              {approval.timerState === "fallback_required" ? (
                <span className="chip chip-version" title="The timer elapsed with no automatic decision configured. The run is held (not failed) until a human decides.">
                  ⏳ needs a decision now
                </span>
              ) : null}
              <span className="muted">{approvalWorkflowLabel(approval)}</span>
              <ShareButton hash={deepLinks.approval(approval.id)} label="Copy share link to this approval" />
            </header>
            <h3><a href={deepLinks.approval(approval.id)}>{approval.title}</a></h3>
            {context.ask?.action ? <p className="approval-card-desc">{context.ask.action}</p> : null}
            <p className="muted approval-card-desc">{context.ask?.reason || approval.description || "No description provided."}</p>
            {pending && approval.timeoutAt ? (
              <p className="muted approval-card-meta">
                {contextApproval.fallbackDecisionLabel
                  ? `Decides itself at ${approval.timeoutAt} → ${contextApproval.fallbackDecisionLabel}`
                  : `Timer elapses at ${approval.timeoutAt}; it will flag itself for a human`}
              </p>
            ) : null}
            {!pending && contextApproval.resolutionSentence ? (
              <p className="muted approval-card-meta">{contextApproval.resolutionSentence}</p>
            ) : null}
            <p className="muted approval-card-meta">
              {approval.runId ? (
                <a href={approval.deepLinkRun || deepLinks.run(approval.runId)}>
                  {approval.runId}
                </a>
              ) : (
                "No linked run"
              )}
              {context.run?.statusLabel ? ` — ${context.run.statusLabel}` : ""}
            </p>
            <div className="toolbar-actions">
              <a className="button" href={deepLinks.approval(approval.id)}>Open approval</a>
              {pending ? (
                <>
                  <button className="primary" onClick={() => resolveApproval(approval.id, "approve")}>Approve</button>
                  <button className="warning" onClick={() => resolveApproval(approval.id, "request-changes")}>Request changes</button>
                  <button className="danger" onClick={() => resolveApproval(approval.id, "reject")}>Reject</button>
                </>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
