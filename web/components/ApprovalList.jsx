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
        const ignored = pending
          ? approval.timeoutAt
            ? contextApproval.fallbackDecisionLabel
              ? `${approval.timeoutAt} → ${contextApproval.fallbackDecisionLabel}`
              : `${approval.timeoutAt} → needs human`
            : "waits for human"
          : contextApproval.resolutionSentence;
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
            <dl className="approval-card-rows">
              <div>
                <dt>Ask</dt>
                <dd>{context.ask?.action || "Record a decision on this approval."}</dd>
              </div>
              <div>
                <dt>Why</dt>
                <dd>{context.ask?.reason || approval.description || "Human sign-off required."}</dd>
              </div>
              <div>
                <dt>Ignored</dt>
                <dd>{ignored}</dd>
              </div>
              <div>
                <dt>Run</dt>
                <dd>
                  {approval.runId ? (
                    <a href={approval.deepLinkRun || deepLinks.run(approval.runId)}>
                      {approval.runId}
                    </a>
                  ) : (
                    "none"
                  )}
                  {context.run?.statusLabel ? ` · ${context.run.statusLabel}` : ""}
                </dd>
              </div>
            </dl>
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
