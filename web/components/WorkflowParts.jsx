import { deepLinks } from "../lib/router.js";
import { runTitle, runProject, runBranch, isActiveRun, formatDuration, runDurationMs, relativeTime } from "../lib/runHelpers.js";
import { copyText } from "../lib/clipboard.js";
import { StatusBadge, Icon } from "./ui.jsx";
import { RunProgressStrip } from "./RunProgressStrip.jsx";

// Glyph shown next to a run in the workflow runs list. Ported 1:1 from the
// legacy runStatusGlyph().
function runStatusGlyph(s) {
  switch (s) {
    case "running":
    case "assigned":
    case "pending": return "▶";
    case "queued": return "⏸";
    case "waiting_approval": return "✋";
    case "succeeded":
    case "recovered":
    case "approved": return "✓";
    case "failed":
    case "error": return "✗";
    case "cancelled":
    case "superseded":
    case "rejected": return "⚠";
    default: return "•";
  }
}

// Pill list. Ported from legacy pills(). `link` derives an href per item;
// `kind` sets the <li> class (e.g. "pill tag").
export function Pills({ items = [], kind = "pill", link = null }) {
  if (!items.length) return null;
  return (
    <ul className="pills" role="list">
      {items.map((item, i) => {
        const label = typeof item === "string" ? item : item.label || item.slug || item.name;
        const href = typeof item === "object" && item.href ? item.href : link ? link(item) : "";
        return (
          <li key={i} className={kind}>
            {href ? <a href={href}>{label}</a> : label}
          </li>
        );
      })}
    </ul>
  );
}

// Collapsible list of a workflow's recent runs. Ported from legacy
// workflowRunsList(). Active runs default open with a live progress strip.
export function WorkflowRunsList({ runs = [], now = Date.now() }) {
  return (
    <ul className="wf-run-list">
      {runs.map((run) => {
        const title = runTitle(run);
        const dur = formatDuration(runDurationMs(run, now));
        const project = runProject(run);
        const branch = runBranch(run);
        const active = isActiveRun(run);
        const glyph = runStatusGlyph(run.status);
        return (
          <li key={run.id} className="wf-run-row" data-status={run.status || ""}>
            <details className="wf-run-progress-details" open={active}>
              <summary className="wf-run-progress-summary">
                <span className="wf-run-glyph" aria-hidden="true">{glyph}</span>
                <a href={deepLinks.run(run.id)} className="wf-run-title">{title}</a>
                <span className="wf-run-status"><StatusBadge value={run.status} /></span>
                <span className="muted wf-run-when">{relativeTime(run.createdAt, now)}{dur ? ` · ${dur}` : ""}</span>
                {project ? <span className="chip chip-project"><Icon name="project" /> {project}</span> : null}
                {branch ? <span className="chip chip-branch"><Icon name="branch" /> {branch}</span> : null}
              </summary>
              <div className="wf-run-progress-body">
                <RunProgressStrip run={run} now={now} />
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export { runStatusGlyph };

// Empty-state block. Ported from legacy empty().
export function Empty({ message, hint = "" }) {
  return (
    <div className="empty">
      <p>{message}</p>
      {hint ? <p className="muted">{hint}</p> : null}
    </div>
  );
}

// Deep-link copy row used on the overview side rail. Mirrors legacy
// data-copy markup behaviour: read-only input + Copy button.
export function CopyRow({ value }) {
  return (
    <div className="copy-row">
      <input readOnly value={value} />
      <button type="button" onClick={() => copyText(value, "Link copied")}>Copy</button>
    </div>
  );
}
