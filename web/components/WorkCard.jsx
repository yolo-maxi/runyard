import { deepLinks } from "../lib/router.js";
import { relativeTime } from "../lib/format.js";
import { WORK_ITEM_STATUSES, runRollupLabel, workItemAction } from "../lib/workItems.js";

// One kanban card. Pure presentational (all data via props) so the SSR render
// smoke test can exercise it without queries; the board wires onMove to a
// PATCH. Dense by design: title, type/priority/project/owner, next action,
// blocked reason, linked-run rollup, attention badge, updated time, move menu.
export function WorkCard({ item, onMove, now = Date.now() }) {
  const runs = item.runs || null;
  const rollup = runRollupLabel(runs);
  const action = workItemAction(item);
  return (
    <article className="work-card" data-work-item={item.id} data-status={item.status}>
      <div className={`work-card-action tone-${action.tone}`}>
        <span>{action.label}</span>
        <strong>{action.detail}</strong>
      </div>
      <h4 className="work-card-title">
        <a href={deepLinks.workItem(item.id)}>{item.title}</a>
      </h4>
      <p className="work-card-chips">
        <span className={`chip work-type-${item.type}`}>{item.type}</span>
        {item.priority && item.priority !== "normal" ? (
          <span className={`chip work-priority-${item.priority}`}>{item.priority}</span>
        ) : null}
        {item.project ? <span className="chip">{item.project}</span> : null}
        {item.owner ? <span className="chip">@{item.owner}</span> : null}
      </p>
      {item.nextAction ? (
        <p className="work-card-next" title={item.nextAction}>Next: {item.nextAction}</p>
      ) : null}
      {item.status === "blocked" && item.blockedReason ? (
        <p className="work-card-blocked" title={item.blockedReason}>Blocked: {item.blockedReason}</p>
      ) : null}
      <p className="work-card-meta">
        {rollup ? <span className="work-card-runs">{rollup}</span> : <span className="muted">no runs</span>}
        {runs?.attention ? (
          <span className="work-attention" title={`${runs.attention} linked run(s) need a human action`}>
            {runs.attention} need attention
          </span>
        ) : null}
      </p>
      <p className="work-card-footer">
        <span className="muted" title={item.updatedAt}>{relativeTime(item.updatedAt, now)}</span>
        {onMove ? (
          <select
            className="work-move"
            aria-label={`Move ${item.title}`}
            value={item.status}
            data-move-work-item={item.id}
            onChange={(e) => onMove(item, e.target.value)}
          >
            {WORK_ITEM_STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        ) : null}
      </p>
    </article>
  );
}
