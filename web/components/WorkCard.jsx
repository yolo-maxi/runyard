import { deepLinks } from "../lib/router.js";
import { relativeTime } from "../lib/format.js";
import { WORK_ITEM_STATUSES, runHealthTone, runRollupLabel, workItemAction } from "../lib/workItems.js";

// One kanban card. Pure presentational (all data via props) so the SSR render
// smoke test can exercise it without queries; the board wires onMove to a
// PATCH. Reading order is deliberate: action pill + age, title, the one next
// move, identity chips, linked-run health, then the quiet move control.
export function WorkCard({ item, onMove, now = Date.now() }) {
  const runs = item.runs || null;
  const rollup = runRollupLabel(runs);
  const health = runHealthTone(runs);
  const action = workItemAction(item);
  const overdue = item.dueAt && Date.parse(item.dueAt) < now && !["shipped", "accepted", "archived"].includes(item.status);
  return (
    <article className="work-card" data-work-item={item.id} data-status={item.status} data-priority={item.priority}>
      <p className="work-card-top">
        <span className={`work-card-action tone-${action.tone}`}><span>{action.label}</span></span>
        {item.priority === "urgent" || item.priority === "high" ? (
          <span className={`chip work-priority-${item.priority}`}>{item.priority}</span>
        ) : null}
        {overdue ? <span className="chip work-overdue" title={item.dueAt}>overdue</span> : null}
        <span className="work-card-age" title={item.updatedAt}>{relativeTime(item.updatedAt, now)}</span>
      </p>
      <h4 className="work-card-title">
        <a href={deepLinks.workItem(item.id)}>{item.title}</a>
      </h4>
      {item.status === "blocked" && item.blockedReason ? (
        <p className="work-card-blocked" title={item.blockedReason}>{item.blockedReason}</p>
      ) : action.detail ? (
        <p className="work-card-next" title={action.detail}>{action.detail}</p>
      ) : null}
      <p className="work-card-chips">
        <span className={`chip work-type-${item.type}`}>{item.type}</span>
        {item.project ? <span className="chip work-chip-project">{item.project}</span> : null}
        {item.owner ? <span className="chip work-chip-owner">@{item.owner}</span> : null}
      </p>
      {runs?.total ? (
        <p className="work-card-meta">
          <span className="work-card-runs">
            <span className={`work-health-dot health-${health}`} aria-hidden="true" />
            {rollup}
          </span>
          {runs.attention ? (
            <span className="work-attention" title={`${runs.attention} linked run(s) need a human action`}>
              {runs.attention} need attention
            </span>
          ) : null}
        </p>
      ) : null}
      {onMove ? (
        <p className="work-card-footer">
          <label className="work-move-wrap">
            <span className="work-move-label">Move</span>
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
          </label>
        </p>
      ) : null}
    </article>
  );
}
