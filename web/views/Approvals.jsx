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

// Humanized labels come from the server-side context (one shared vocabulary
// for web, Telegram, and diagnostics); these fall back gracefully for rows
// that predate it.
function approvalDecisionLabel(approval) {
  const fromContext = approval?.context?.approval?.resolutionSentence;
  if (fromContext) return fromContext;
  const decision = approval?.resolution || approval?.decision || approval?.status || "";
  if (decision === "approved") return "Approved";
  if (decision === "changes_requested") return "Changes requested";
  if (decision === "rejected") return "Rejected";
  if (decision === "superseded") return "Superseded — the run ended first";
  return decision ? "Resolved" : "Pending";
}

function approvalStatusBadgeProps(approval) {
  const context = approval?.context?.approval || {};
  return {
    value: approval?.resolution || approval?.status,
    label:
      approval?.status === "pending"
        ? context.statusLabel || "Pending decision"
        : context.resolutionLabel || approvalDecisionLabel(approval)
  };
}

function ApprovalRow({ label, children }) {
  if (children == null || children === "" || children === false) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
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
  const ignoredLine = approval.timeoutAt
    ? context.approval?.fallbackDecisionLabel
      ? `${approval.timeoutAt} → ${context.approval.fallbackDecisionLabel}`
      : `${approval.timeoutAt} → needs human; no auto decision`
    : "waits for a human; run held";

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
        <StatusBadge {...approvalStatusBadgeProps(approval)} />
        {context.approval?.kindLabel ? <span className="chip">{context.approval.kindLabel}</span> : null}
        <span className="run-id-mono">{approval.id}</span>
        <span className="muted">{approval.createdAt || ""}</span>
      </p>
      <section className="approval-detail-grid">
        <div className="panel approval-main">
          <h2>Decision</h2>
          <dl className="approval-summary">
            <ApprovalRow label="Ask">
              {context.ask?.action || context.whatHappensIfApproved || "Approving marks this approval approved."}
              {context.ask?.derived ? <span className="muted"> (derived)</span> : null}
            </ApprovalRow>
            <ApprovalRow label="Why">{context.ask?.reason || approval.description || "Human sign-off required."}</ApprovalRow>
            <ApprovalRow label="Who">{context.ask?.audienceLabel}</ApprovalRow>
            <ApprovalRow label="Ignored">{ignoredLine}</ApprovalRow>
          </dl>
          {approval.timerState === "fallback_required" ? (
            <p className="notice">
              Expired {approval.timerElapsedAt ? `${approval.timerElapsedAt}: ` : ""}needs a human. No automatic decision was configured; the run stays held.
            </p>
          ) : null}
          <h3>Context</h3>
          <dl className="approval-facts">
            <ApprovalRow label="From">{context.requestedBy || approval.requestedBy || "workflow"}</ApprovalRow>
            <ApprovalRow label="Workflow">
              {workflow?.deepLink ? <a href={workflow.deepLink}>{workflowLabel}</a> : workflowLabel}
            </ApprovalRow>
            <ApprovalRow label="Project">{project.display || ""}</ApprovalRow>
            <ApprovalRow label="Branch">{targetBranch}</ApprovalRow>
            {deploy != null ? (
              <div>
                <dt>Deploy</dt>
                <dd>
                <span className={`chip ${deploy ? "chip-runner" : "chip-version"}`}>{deploy ? "yes" : "no"}</span>
                </dd>
              </div>
            ) : null}
            <ApprovalRow label="Card"><span className="run-id-mono">{approval.id}</span></ApprovalRow>
            <ApprovalRow label="Run">{runLink}</ApprovalRow>
            <ApprovalRow label="Timer">{approval.timeoutAt ? ignoredLine : ""}</ApprovalRow>
          </dl>
          {context.proposedChange ? (
            <>
              <h3>Details</h3>
              <p className="approval-proposed-change">{context.proposedChange}</p>
            </>
          ) : null}
          {run ? (
            <>
              <h3>Linked run</h3>
              <p><strong>{run.title || approval.runId}</strong> <StatusBadge value={run.status} label={run.statusLabel} /></p>
              <p className="muted">{run.description || run.currentStep || ""}</p>
            </>
          ) : null}
          <h3>Outcomes</h3>
          <dl className="approval-outcomes">
            <ApprovalRow label="Approve">{context.whatHappensIfApproved || "This approval is marked approved."}</ApprovalRow>
            <ApprovalRow label="Changes">{context.whatHappensIfChangesRequested || "Your note records what should change."}</ApprovalRow>
            <ApprovalRow label="Reject">{context.whatHappensIfRejected || "This approval is marked rejected."}</ApprovalRow>
          </dl>
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
                By {approval.resolvedBy || "unknown"} at {approval.resolvedAt || "unknown"}
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
