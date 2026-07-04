import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { approvalWorkflowLabel } from "../lib/runHelpers.js";
import { resolveApproval } from "../lib/approvalActions.js";
import { Toolbar, StatusBadge, Breadcrumbs, JsonBlock } from "../components/ui.jsx";
import { ApprovalList } from "../components/ApprovalList.jsx";
import { copyText } from "../lib/clipboard.js";

// Approval context helper. Ported from legacy approvalContext().
function approvalContext(approval) {
  return approval?.context || {};
}

function approvalDecisionLabel(approval) {
  const decision = approval?.resolution || approval?.decision || approval?.status || "";
  if (decision === "approved") return "Approved";
  if (decision === "changes_requested") return "Changes requested";
  if (decision === "rejected") return "Rejected";
  if (decision === "superseded") return "Superseded (run ended)";
  return decision || "Pending";
}

// Single labeled fact row. Ported from legacy approvalFact(); renders nothing
// when value is empty.
function ApprovalFact({ label, children }) {
  if (children == null || children === "" || children === false) return null;
  return (
    <p>
      <span className="muted">{label}</span>
      <br />
      {children}
    </p>
  );
}

// Approvals list. Ported from renderApprovals().
export function Approvals() {
  const { data, isLoading } = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api("/api/approvals")
  });
  const approvals = data?.approvals || [];
  return (
    <>
      <Toolbar title="Approvals" shareHash={deepLinks.approvals()} />
      {isLoading && !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <ApprovalList approvals={approvals} />
      )}
    </>
  );
}

// Approval detail + decision form. Ported from renderApprovalDetail().
export function ApprovalDetail({ id }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const { data, error, isLoading } = useQuery({
    queryKey: ["approval", id],
    queryFn: () => api(`/api/approvals/${encodeURIComponent(id)}`),
    retry: false
  });

  const decide = useCallback(
    async (decision) => {
      await resolveApproval(id, decision, { comment });
      setComment("");
      await queryClient.invalidateQueries({ queryKey: ["approval", id] });
    },
    [id, comment, queryClient]
  );

  if (error) {
    return (
      <>
        <Breadcrumbs items={[
          { label: "Approvals", href: deepLinks.approvals() },
          { label: id, href: deepLinks.approval(id), title: `Approval ${id}`, current: true }
        ]} />
        <Toolbar title="Approval" shareHash={deepLinks.approval(id)}>
          <a className="button" href={deepLinks.approvals()}>All approvals</a>
        </Toolbar>
        <section className="panel"><p className="muted">{error.message}</p></section>
      </>
    );
  }

  if (isLoading && !data) {
    return <section className="panel"><p className="muted">Loading approval…</p></section>;
  }

  const approval = data.approval;
  const context = approvalContext(approval);
  const workflow = context.workflow;
  const run = context.run;
  const project = context.project || {};
  const canResolve = approval.status === "pending";
  const workflowLabel = approvalWorkflowLabel(approval);
  const linkUrl = deepLinks.abs(deepLinks.approval(approval.id));

  const targetBranch = context.targetBranch || context.branch || "";
  const deploy = context.deploy;

  const runLink = run || approval.deepLinkRun
    ? (
      <>
        <a className="button" href={run?.deepLink || approval.deepLinkRun}>Open run</a>
        <span className="muted approval-run-id">{approval.runId || run?.id || ""}</span>
      </>
    )
    : <span className="muted">No linked run</span>;

  return (
    <>
      <Breadcrumbs items={[
        { label: "Approvals", href: deepLinks.approvals() },
        workflow?.deepLink ? { label: workflowLabel, href: workflow.deepLink } : null,
        { label: approval.id, href: deepLinks.approval(approval.id), title: approval.title || `Approval ${approval.id}`, current: true }
      ].filter(Boolean)} />
      <Toolbar title={approval.title} shareHash={deepLinks.approval(approval.id)}>
        <a className="button" href={deepLinks.approvals()}>All approvals</a>
        {run ? <a className="button" href={run.deepLink}>Open run</a> : null}
      </Toolbar>
      <p className="approval-detail-sub">
        <StatusBadge value={approval.resolution || approval.status} />
        <span className="run-id-mono">{approval.id}</span>
        <span className="muted">{approval.createdAt || ""}</span>
      </p>
      <section className="approval-detail-grid">
        <div className="panel approval-main">
          <h2>Context</h2>
          <p className="approval-description">{approval.description || "No description provided."}</p>
          <div className="approval-facts">
            <ApprovalFact label="Requested by">{context.requestedBy || approval.requestedBy || "workflow"}</ApprovalFact>
            <ApprovalFact label="Workflow">
              {workflow?.deepLink ? <a href={workflow.deepLink}>{workflowLabel}</a> : workflowLabel}
            </ApprovalFact>
            <ApprovalFact label="Project / repo / path">{project.display || ""}</ApprovalFact>
            <ApprovalFact label="Target branch">{targetBranch}</ApprovalFact>
            {deploy != null ? (
              <p>
                <span className="muted">Deploy</span>
                <br />
                <span className={`chip ${deploy ? "chip-runner" : "chip-version"}`}>{deploy ? "yes" : "no"}</span>
              </p>
            ) : null}
            <ApprovalFact label="Approval ID"><span className="run-id-mono">{approval.id}</span></ApprovalFact>
            <ApprovalFact label="Run">{runLink}</ApprovalFact>
            <ApprovalFact label="Timer">
              {approval.timeoutAt
                ? `Elapses ${approval.timeoutAt}` +
                  (approval.fallback?.decision ? `, then falls back to "${approval.fallback.decision}"` : ", no fallback configured")
                : ""}
            </ApprovalFact>
          </div>
          {approval.timerState === "fallback_required" ? (
            <p className="notice">
              ⏳ The approval timer elapsed {approval.timerElapsedAt ? `at ${approval.timerElapsedAt} ` : ""}with no configured
              fallback. The linked run is held open (not failed) until you decide.
            </p>
          ) : null}
          {context.proposedChange ? (
            <>
              <h3>Proposed change</h3>
              <p className="approval-proposed-change">{context.proposedChange}</p>
            </>
          ) : null}
          {run ? (
            <>
              <h3>Linked run</h3>
              <p><strong>{run.title || approval.runId}</strong> <StatusBadge value={run.status} /></p>
              <p className="muted">{run.description || run.currentStep || ""}</p>
            </>
          ) : null}
          <h3>Proposed action</h3>
          <p className="notice">{context.proposedAction || context.whatHappensIfApproved || "Approving marks this approval approved."}</p>
          <h3>Decision outcomes</h3>
          <p className="muted">{context.whatHappensIfApproved || "Approving marks this approval approved."}</p>
          <p className="muted">{context.whatHappensIfChangesRequested || "Requesting changes records changes_requested."}</p>
          <p className="muted">{context.whatHappensIfRejected || "Rejecting marks this approval rejected."}</p>
          {canResolve ? (
            <div className="approval-decision">
              <label>
                Decision note
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Optional for approve/reject. For request changes, describe the new inputs or changes needed."
                />
              </label>
              <div className="toolbar-actions">
                <button className="primary" onClick={() => decide("approve")}>Approve</button>
                <button className="warning" onClick={() => decide("request-changes")}>Request changes</button>
                <button className="danger" onClick={() => decide("reject")}>Reject</button>
              </div>
            </div>
          ) : (
            <p className="approval-resolved">
              <strong>{approvalDecisionLabel(approval)}</strong>
              <br />
              <span className="muted">
                Resolved by {approval.resolvedBy || "unknown"} at {approval.resolvedAt || "unknown"}
                {approval.comment ? `: ${approval.comment}` : ""}
              </span>
            </p>
          )}
        </div>
        <aside className="panel approval-side">
          <h2>Approval link</h2>
          <div className="copy-row">
            <input readOnly value={linkUrl} />
            <button onClick={() => copyText(linkUrl, "Link copied")}>Copy</button>
          </div>
          <h3>Payload summary</h3>
          <JsonBlock value={approval.payloadSummary || approval.payload || {}} />
        </aside>
      </section>
    </>
  );
}
