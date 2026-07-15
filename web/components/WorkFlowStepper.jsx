import { deepLinks } from "../lib/router.js";
import { formatDuration, relativeTime } from "../lib/format.js";
import { FLOW_STATE_GLYPHS } from "../lib/workItems.js";

// Execution-flow stepper: renders GET /api/runs/:id/flow as a vertical list of
// steps with honest per-step state. Pure presentational (flow via props) so
// the SSR smoke test can render it; the detail view owns fetching/polling.

function stepDuration(node, now = Date.now()) {
  if (!node.startedAt) return "";
  const start = Date.parse(node.startedAt);
  if (Number.isNaN(start)) return "";
  const end = node.finishedAt ? Date.parse(node.finishedAt) : now;
  if (Number.isNaN(end)) return "";
  return formatDuration(Math.max(0, end - start));
}

export function WorkFlowStep({ node, now = Date.now() }) {
  const duration = stepDuration(node, now);
  return (
    <li className={`work-flow-step state-${node.state}`} data-flow-node={node.id}>
      <span className="work-flow-glyph" aria-hidden="true">{FLOW_STATE_GLYPHS[node.state] || "○"}</span>
      <span className="work-flow-label">
        {node.label || node.id}
        {node.kind && node.kind !== "task" ? <span className="chip work-flow-kind">{node.kind}</span> : null}
      </span>
      <span className="work-flow-detail muted">
        {node.state}
        {duration ? ` · ${duration}` : ""}
        {node.errors ? ` · ${node.errors} error event${node.errors === 1 ? "" : "s"}` : ""}
        {node.state === "active" && node.lastEventType ? ` · ${node.lastEventType}` : ""}
      </span>
    </li>
  );
}

export function WorkFlowStepper({ flow, now = Date.now() }) {
  if (!flow) return null;
  const steps = (flow.nodes || []).filter((node) => node.kind !== "entry" && node.type !== "entry");
  const counts = flow.counts || {};
  const summary = ["done", "active", "waiting", "failed", "pending"]
    .filter((state) => counts[state])
    .map((state) => `${counts[state]} ${state}`)
    .join(" · ");
  return (
    <div className="work-flow" data-flow-run={flow.runId}>
      <p className="work-flow-summary muted">
        {flow.name} · run <a href={deepLinks.run(flow.runId)}>{flow.runId}</a> · {flow.status}
        {flow.currentStep ? ` · ${flow.currentStep}` : ""}
        {summary ? ` — ${summary}` : ""}
      </p>
      {flow.error ? <p className="work-flow-error">{flow.error}</p> : null}
      {steps.length ? (
        <ol className="work-flow-steps">
          {steps.map((node) => (
            <WorkFlowStep key={node.id} node={node} now={now} />
          ))}
        </ol>
      ) : (
        <p className="muted">No steps observed yet{flow.source === "events" ? "" : " for this workflow"}.</p>
      )}
      {(flow.pendingApprovals || []).map((approval) => (
        <p key={approval.id} className="work-flow-approval">
          ⏸ Approval pending: <a href={deepLinks.approval(approval.id)}>{approval.title}</a>{" "}
          <span className="muted">{relativeTime(approval.createdAt, now)}</span>
        </p>
      ))}
    </div>
  );
}
