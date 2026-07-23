import { createCollection } from "@tanstack/react-db";
import { api } from "./api.js";
import { decorateEvent } from "./runEvents.js";

// A per-run TanStack DB collection whose sync source is the live SSE stream
// (GET /api/runs/:id/events/stream), with a graceful fallback to polling
// /api/runs/:id/events when the stream is unavailable or drops. The live
// console reads this collection via useLiveQuery, so new events flow into the
// UI reactively — the "screen moving" feel — without any manual setInterval in
// the component.
//
// onStatus(status) reports:
// "connecting" | "live" | "reconnecting" | "polling" | "ended".
// "ended" fires on the stream's run-terminal frame — the run is terminal and
// fully drained, so the collection closes the stream and stops syncing.
export function createRunEventsCollection(runId, { onStatus } = {}) {
  const seen = new Set();
  let handle = null;
  let es = null;
  let pollTimer = null;
  let stopped = false;

  function writeEvents(events) {
    if (!handle) return;
    const fresh = (events || []).filter((e) => e && e.id && !seen.has(e.id));
    if (!fresh.length) return;
    handle.begin();
    for (const e of fresh) {
      seen.add(e.id);
      handle.write({ type: "insert", value: decorateEvent(e) });
    }
    handle.commit();
  }

  async function backfill() {
    try {
      const data = await api(`/api/runs/${encodeURIComponent(runId)}/events`);
      writeEvents(data.events || []);
    } catch {
      // transient — the stream or next poll will catch up
    }
  }

  function startPolling() {
    if (stopped || pollTimer) return;
    onStatus?.("polling");
    pollTimer = setInterval(() => {
      if (!stopped) backfill();
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startStream() {
    if (stopped) return;
    if (typeof EventSource === "undefined") {
      startPolling();
      return;
    }
    try {
      es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events/stream`, { withCredentials: true });
    } catch {
      startPolling();
      return;
    }
    es.addEventListener("ready", () => {
      // Stream is healthy: stop any fallback poll and reconcile any gap.
      stopPolling();
      onStatus?.("live");
      backfill();
    });
    es.addEventListener("run-event", (ev) => {
      try {
        writeEvents([JSON.parse(ev.data)]);
      } catch {
        /* malformed frame — ignore */
      }
    });
    es.addEventListener("run-terminal", () => {
      // The run is terminal and fully drained: the server is about to close
      // the stream. Close our side first so EventSource does not auto-
      // reconnect, reconcile once, and stay in the final state (no polling).
      onStatus?.("ended");
      if (es) {
        es.close();
        es = null;
      }
      backfill();
    });
    es.onerror = () => {
      if (stopped) return;
      // CLOSED → the browser won't retry (auth/HTTP error / unavailable):
      // fall back to polling. CONNECTING → it is auto-retrying; surface that.
      if (!es || es.readyState === EventSource.CLOSED) {
        if (es) es.close();
        es = null;
        startPolling();
      } else {
        onStatus?.("reconnecting");
      }
    };
  }

  const collection = createCollection({
    id: `run-events:${runId}`,
    gcTime: 1000, // tear the sync (and SSE) down promptly once the console unmounts
    getKey: (e) => e.id,
    sync: {
      sync: (params) => {
        handle = params;
        onStatus?.("connecting");
        // Initial load first so the console shows history immediately, then
        // attach the live stream.
        backfill().then(() => {
          handle.markReady();
          startStream();
        });
        return () => {
          stopped = true;
          stopPolling();
          if (es) {
            es.close();
            es = null;
          }
        };
      }
    }
  });

  return collection;
}
