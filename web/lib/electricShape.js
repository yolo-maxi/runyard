// Minimal ElectricSQL HTTP Shape client (browser).
//
// Speaks the real Electric shape-log protocol against the RunYard auth proxy
// (/api/electric/v1/shape): initial sync at offset=-1, page forward until
// up-to-date, then long-poll live=true for changes. Handles handle rotation,
// 409 must-refetch, and network backoff. No external dependency — it consumes
// the same protocol as @electric-sql/client but stays tiny and proxy-only.
import { ELECTRIC_SHAPE_URL } from "./electricConfig.js";
import { classifyShapeMessages } from "./shapeProtocol.js";

const MAX_BACKOFF_MS = 5000;

function backoff(failures) {
  return Math.min(500 * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// onOps(ops)         — array of {operation, key, value} change messages
// onUpToDate()       — fired each time the stream reaches up-to-date
// onMustRefetch()    — the shape rotated; the caller should clear + resync
// onError(err)       — a transient fetch/HTTP error (stream keeps retrying)
export function createShapeStream({
  table,
  params = {},
  onOps,
  onUpToDate,
  onMustRefetch,
  onError
}) {
  let offset = "-1";
  let handle = null;
  let live = false;
  let stopped = false;
  let failures = 0;
  let controller = null;

  function reset() {
    offset = "-1";
    handle = null;
    live = false;
  }

  async function loop() {
    while (!stopped) {
      const url = new URL(ELECTRIC_SHAPE_URL, window.location.origin);
      url.searchParams.set("table", table);
      if (params.run_id) url.searchParams.set("run_id", params.run_id);
      // Request full rows on update so change messages carry every column (the
      // default sends only changed columns, which would clobber the local row).
      if (params.replica) url.searchParams.set("replica", params.replica);
      url.searchParams.set("offset", offset);
      if (handle) url.searchParams.set("handle", handle);
      if (live) url.searchParams.set("live", "true");

      controller = new AbortController();
      let res;
      try {
        res = await fetch(url, {
          credentials: "include",
          headers: { accept: "application/json" },
          signal: controller.signal
        });
      } catch (err) {
        if (stopped) return;
        failures += 1;
        onError?.(err);
        await delay(backoff(failures));
        continue;
      }

      if (res.status === 409) {
        // Shape rotated / offset no longer valid — resync from scratch.
        reset();
        onMustRefetch?.();
        continue;
      }
      if (!res.ok) {
        failures += 1;
        onError?.(new Error(`electric shape http ${res.status}`));
        await delay(backoff(failures));
        continue;
      }
      failures = 0;

      const newHandle = res.headers.get("electric-handle");
      if (newHandle) handle = newHandle;
      const upToDateHeader = res.headers.get("electric-up-to-date") != null;
      const newOffset = res.headers.get("electric-offset");

      let messages = [];
      if (res.status !== 204) {
        const text = await res.text();
        if (text) {
          try {
            messages = JSON.parse(text);
          } catch {
            /* malformed page — treat as empty, next poll recovers */
          }
        }
      }

      const classified = classifyShapeMessages(messages);
      const sawUpToDate = upToDateHeader || classified.upToDate;
      const ops = classified.ops;

      if (classified.mustRefetch) {
        reset();
        onMustRefetch?.();
        continue;
      }

      if (ops.length) onOps?.(ops);
      if (newOffset) offset = newOffset;
      if (sawUpToDate) {
        live = true;
        onUpToDate?.();
      }
      // When live, the request itself long-polls (blocks until data/timeout), so
      // this loop naturally paces itself. When still catching up, it pages fast.
    }
  }

  loop();

  return {
    stop() {
      stopped = true;
      try {
        controller?.abort();
      } catch {
        /* already settled */
      }
    }
  };
}
