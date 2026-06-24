import { useMemo, useState } from "react";
import { useLocalStorage } from "../lib/storage.js";
import { formatTimestamp } from "../lib/runHelpers.js";
import {
  decorateEvent, runLogTextDump, RUN_LOG_NOISY_CATEGORIES
} from "../lib/runEvents.js";
import { copyText } from "../lib/clipboard.js";

function isEmphasised(e) {
  if (e.severity === "error" || e.severity === "warn") return true;
  if (e.category === "approval") return true;
  return /(obstruct|retrospect|failure|cancel)/i.test(e.type);
}

export function EventRow({ entry, node = true }) {
  return (
    <li
      className={`run-log-event run-log-sev-${entry.severity} run-log-cat-${entry.category}${entry.noisy ? " run-log-noisy" : ""}${isEmphasised(entry) ? " run-log-emphasised" : ""}`}
      data-category={entry.category}
      data-severity={entry.severity}
      data-node={entry.node || ""}
    >
      <time>{formatTimestamp(entry.createdAt)}</time>
      <code className="run-log-type">{entry.type}</code>
      {node && entry.node ? <span className="run-log-node-chip" title="node">{entry.node}</span> : null}
      <span className="run-log-msg">{entry.message || ""}</span>
    </li>
  );
}

// Structured run log. Ported from renderRunLog() — counts strip, search, a
// "hide routine events" toggle, line-wrap, and severity emphasis. (The legacy
// clickable category/severity/node filter chips are folded into the free-text
// search here; the live console panel above handles the streaming feel.)
export function RunLog({ events = [], summary = null }) {
  const [query, setQuery] = useState("");
  const [hideRoutine, setHideRoutine] = useLocalStorage("runLogHideRoutine", false);
  const [wrap, setWrap] = useLocalStorage("runDetail.logWrap", false);

  const totals = summary?.totals || {
    events: events.length,
    errors: 0,
    warnings: 0,
    highlights: 0
  };

  const decorated = useMemo(() => {
    const collapsed = new Set(summary?.defaultCollapsed || [...RUN_LOG_NOISY_CATEGORIES]);
    return events.map((e) => {
      const d = decorateEvent(e);
      d.noisy = collapsed.has(d.category);
      return d;
    });
  }, [events, summary]);

  const noisyCount = decorated.filter((e) => e.noisy).length;
  const q = query.trim().toLowerCase();
  const visible = decorated.filter((e) => {
    if (hideRoutine && e.noisy) return false;
    if (!q) return true;
    return `${e.type} ${e.message || ""} ${e.node || ""}`.toLowerCase().includes(q);
  });

  if (!events.length) {
    return <><h3>Timeline</h3><p className="muted">No events yet.</p></>;
  }

  return (
    <div className="run-log">
      <div className="run-log-toolbar">
        <dl className="run-log-totals">
          <div className="run-log-total"><dt>events</dt><dd>{totals.events ?? events.length}</dd></div>
          <div className="run-log-total run-log-total-error"><dt>errors</dt><dd>{totals.errors ?? 0}</dd></div>
          <div className="run-log-total run-log-total-warn"><dt>warnings</dt><dd>{totals.warnings ?? 0}</dd></div>
          <div className="run-log-total"><dt>highlights</dt><dd>{totals.highlights ?? 0}</dd></div>
        </dl>
        <label className="run-log-search">
          <span className="muted">Search</span>
          <input type="search" id="run-log-search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter by text, type, or node" autoComplete="off" />
        </label>
        <label className="run-log-wrap-toggle" title="Wrap long log lines">
          <input type="checkbox" id="run-log-wrap-toggle" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        {noisyCount ? (
          <label className="run-log-noisy-toggle">
            <input type="checkbox" id="run-log-hide-routine" checked={hideRoutine} onChange={(e) => setHideRoutine(e.target.checked)} />
            Hide {noisyCount} routine event{noisyCount === 1 ? "" : "s"} <span className="muted">(heartbeats &amp; traces)</span>
          </label>
        ) : null}
        <button type="button" className="button" title="Copy the raw timeline" onClick={() => copyText(runLogTextDump(events), "Log copied")}>Copy log</button>
      </div>
      <ol className={`run-log-list${wrap ? " run-log-wrap" : ""}`}>
        {visible.map((entry) => <EventRow key={entry.id} entry={entry} />)}
      </ol>
      {visible.length === 0 ? <p className="muted">No events match the current filter.</p> : null}
    </div>
  );
}
