import { createCollection } from "@tanstack/react-db";
import { api } from "./api.js";
import { decorateEvent } from "./runEvents.js";
import { electricEnabled } from "./electricConfig.js";
import { createShapeStream } from "./electricShape.js";
import { normalizeRunEventRow } from "./electricNormalize.js";

// A per-run TanStack DB collection of run events (the live CLI/agent trace).
// The live console reads this via useLiveQuery, so new events flow into the UI
// reactively — the "screen moving" feel — with no setInterval in the component.
//
// This branch streams the trace from an ElectricSQL shape over run_events scoped
// to a single run_id (via the auth proxy). SQLite -> Postgres projection makes
// each persisted run event show up in the shape log within a projector tick, so
// the console updates live as the agent works. If Electric is disabled or the
// stream hard-fails, it falls back to the original SSE + 3s-poll path.
//
// onStatus(status) reports: "connecting" | "live" | "reconnecting" | "polling".

function createElectricRunEventsCollection(runId, { onStatus } = {}) {
  let handle = null;
  let stream = null;
  let pollTimer = null;
  let stopped = false;
  let ready = false;
  let hardFailures = 0;
  const seen = new Set();

  function writeEvents(events) {
    if (!handle) return;
    const fresh = (events || []).filter((e) => e && e.id && !seen.has(e.id));
    if (!fresh.length) return;
    handle.begin();
    for (const e of fresh) {
      seen.add(e.id);
      handle.write({ type: "insert", value: e });
    }
    handle.commit();
  }

  function ensureReady() {
    if (!ready) {
      ready = true;
      handle?.markReady();
    }
  }

  async function pollOnce() {
    try {
      const data = await api(`/api/runs/${encodeURIComponent(runId)}/events`);
      writeEvents((data.events || []).map((e) => decorateEvent(e)));
      ensureReady();
    } catch {
      /* transient */
    }
  }

  function startFallback() {
    if (stopped || pollTimer) return;
    if (stream) {
      stream.stop();
      stream = null;
    }
    onStatus?.("polling");
    pollOnce();
    pollTimer = setInterval(pollOnce, 3000);
  }

  function startStream() {
    onStatus?.("connecting");
    stream = createShapeStream({
      table: "run_events",
      params: { run_id: runId, replica: "full" },
      onOps: (ops) => {
        const rows = ops
          .filter((op) => op.operation !== "delete")
          .map((op) => normalizeRunEventRow(op.value));
        writeEvents(rows);
      },
      onUpToDate: () => {
        hardFailures = 0;
        onStatus?.("live");
        ensureReady();
      },
      onMustRefetch: () => {
        /* immutable append-only log; a rotation just replays inserts */
      },
      onError: () => {
        hardFailures += 1;
        onStatus?.("reconnecting");
        if (hardFailures >= 4) startFallback();
      }
    });
  }

  return createCollection({
    id: `run-events:${runId}`,
    gcTime: 1000,
    getKey: (e) => e.id,
    sync: {
      sync: (params) => {
        handle = params;
        startStream();
        return () => {
          stopped = true;
          if (stream) stream.stop();
          if (pollTimer) clearInterval(pollTimer);
        };
      }
    }
  });
}

// Legacy SSE + poll collection (used when Electric is disabled).
function createSseRunEventsCollection(runId, { onStatus } = {}) {
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
    es.onerror = () => {
      if (stopped) return;
      if (!es || es.readyState === EventSource.CLOSED) {
        if (es) es.close();
        es = null;
        startPolling();
      } else {
        onStatus?.("reconnecting");
      }
    };
  }

  return createCollection({
    id: `run-events:${runId}`,
    gcTime: 1000,
    getKey: (e) => e.id,
    sync: {
      sync: (params) => {
        handle = params;
        onStatus?.("connecting");
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
}

export function createRunEventsCollection(runId, opts = {}) {
  return electricEnabled()
    ? createElectricRunEventsCollection(runId, opts)
    : createSseRunEventsCollection(runId, opts);
}
