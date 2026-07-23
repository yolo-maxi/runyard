import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { createRunEventsCollection } from "../lib/runEventsCollection.js";
import { formatTimestamp } from "../lib/runHelpers.js";

const STATUS_LABEL = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  polling: "Polling (stream unavailable)",
  ended: "Complete"
};

// Live event console for a run. Tails the SSE-backed TanStack events collection
// and auto-scrolls as events arrive ("screen moving" feel). Pause freezes the
// scroll (events keep accumulating, with a "N new" jump-to-latest control);
// resume re-follows the tail. Falls back to polling if SSE drops/unavailable.
export function LiveConsole({ runId, live = true }) {
  const [status, setStatus] = useState("connecting");
  const [paused, setPaused] = useState(false);
  const collection = useMemo(() => createRunEventsCollection(runId, { onStatus: setStatus }), [runId]);
  const { data: events = [] } = useLiveQuery((q) => collection, [collection]);

  const ordered = useMemo(
    () => [...events].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)),
    [events]
  );

  const bodyRef = useRef(null);
  // Count of events that arrived while paused (so we can offer "jump to latest").
  const pauseAnchorRef = useRef(0);
  const newWhilePaused = paused ? Math.max(0, ordered.length - pauseAnchorRef.current) : 0;

  function scrollToBottom() {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Auto-follow the tail unless paused.
  useLayoutEffect(() => {
    if (!paused) scrollToBottom();
  }, [ordered.length, paused]);

  function togglePause() {
    setPaused((p) => {
      const next = !p;
      if (next) pauseAnchorRef.current = ordered.length;
      else queueMicrotask(scrollToBottom);
      return next;
    });
  }

  const streaming = live && (status === "live" || status === "connecting" || status === "reconnecting");

  return (
    <div className="live-console" data-status={status}>
      <div className="live-console-toolbar">
        <span className={`live-console-status live-console-status-${status}`}>
          <span className="live-console-dot" aria-hidden="true" /> {STATUS_LABEL[status] || status}
        </span>
        <span className="muted live-console-count">{ordered.length} event{ordered.length === 1 ? "" : "s"}</span>
        <span className="live-console-actions">
          {newWhilePaused > 0 ? (
            <button type="button" className="button live-console-jump" onClick={togglePause} title="Resume and jump to the latest events">
              {newWhilePaused} new ↓
            </button>
          ) : null}
          <button
            type="button"
            className="button live-console-pause"
            aria-pressed={paused}
            onClick={togglePause}
            title={paused ? "Resume auto-scroll" : "Pause auto-scroll"}
          >
            {paused ? "▶ Resume" : "❚❚ Pause"}
          </button>
        </span>
      </div>
      <div className="live-console-body" ref={bodyRef} aria-live={paused ? "off" : "polite"} role="log">
        {ordered.length === 0 ? (
          <p className="muted live-console-empty">
            {streaming ? "Waiting for events…" : "No events yet."}
          </p>
        ) : (
          <ol className="live-console-list">
            {ordered.map((e) => (
              <li key={e.id} className={`live-console-line live-console-sev-${e.severity} live-console-cat-${e.category}`}>
                <time className="live-console-time">{formatTimestamp(e.createdAt)}</time>
                <code className="live-console-type">{e.type}</code>
                {e.node ? <span className="live-console-node" title="node">{e.node}</span> : null}
                <span className="live-console-msg">{e.message || ""}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
