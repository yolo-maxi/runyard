// Minimal SSE client for the Hub's run-event stream, mirroring the Smithers
// gateway-client's resilient streaming semantics (see
// @smithers-orchestrator/gateway-client SmithersGatewayClient.ts):
//   - resume from the last observed per-run seq on reconnect (afterSeq),
//   - exponential backoff with full symmetric jitter (gatewayBackoffDelay),
//   - backoff only resets once a connection is demonstrably healthy,
//   - a graceful stream end without a terminal frame is treated as a silent
//     drop (close code 1006 equivalent) and reconnects,
//   - a terminal frame or an aborted signal stops the loop cleanly.
// The transport differs (HTTP SSE with Bearer auth instead of a WebSocket
// RPC), so the wire parsing lives here: an incremental, chunk-boundary-safe
// SSE parser per the EventSource spec.

// --- SSE wire parser ---------------------------------------------------------
// Feed arbitrary chunks; frames are dispatched on blank lines. Handles \r\n,
// multi-line data fields, comments, and `id:`/`event:`/`retry:` fields. Per
// the spec, an incomplete trailing event at EOF is discarded (no flush).
export function createSseParser(onFrame) {
  let buffer = "";
  let eventName = "";
  let dataLines = [];
  let frameId;

  function processLine(line) {
    if (line === "") {
      if (dataLines.length > 0 || eventName || frameId !== undefined) {
        onFrame({
          event: eventName || "message",
          data: dataLines.join("\n"),
          ...(frameId !== undefined ? { id: frameId } : {})
        });
      }
      eventName = "";
      dataLines = [];
      frameId = undefined;
      return;
    }
    if (line.startsWith(":")) return; // comment / keepalive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id" && !value.includes("\0")) frameId = value;
    // retry: ignored — reconnect pacing is owned by followRunEvents' backoff.
  }

  return {
    feed(chunk) {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLine(line);
      }
    }
  };
}

// --- Backoff (mirror of gatewayBackoffDelay) ---------------------------------
export function streamBackoffDelay(attempt, options = {}) {
  const baseMs = options.baseMs ?? 250;
  const maxMs = options.maxMs ?? 10_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.5;
  const random = options.random ?? Math.random;
  const raw = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt));
  const delta = (random() * 2 - 1) * raw * jitter;
  return Math.max(0, Math.round(raw + delta));
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function isAuthStreamError(error) {
  return error?.status === 401 || error?.status === 403;
}

// Errors that reconnecting cannot fix: bad credentials, unknown run, invalid
// cursor, or the hub explicitly refusing more tails is retryable? 429 is
// transient by nature (another tail may close), so it stays retryable.
function isFatalStreamError(error) {
  return isAuthStreamError(error) || error?.status === 404 || error?.status === 400;
}

// --- Single connection -------------------------------------------------------
// Async generator of parsed SSE frames from one stream connection. Throws an
// Error with .status for non-2xx responses (before any frame is yielded).
export async function* streamRunEvents({
  baseUrl,
  token,
  runId,
  afterSeq = -1,
  signal,
  fetchImpl = fetch
}) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  const query = afterSeq >= 0 ? `?afterSeq=${afterSeq}` : "";
  const response = await fetchImpl(`${base}/api/runs/${encodeURIComponent(runId)}/events/stream${query}`, {
    headers: {
      accept: "text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    signal
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.error || "";
    } catch {
      /* non-JSON error body */
    }
    const error = new Error(detail || `stream HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  const parser = createSseParser((frame) => frames.push(frame));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (frames.length) yield frames.shift();
    }
    parser.feed(decoder.decode());
    while (frames.length) yield frames.shift();
  } finally {
    try {
      reader.releaseLock();
      await response.body.cancel?.();
    } catch {
      /* connection already gone */
    }
  }
}

// --- Resilient follow --------------------------------------------------------
// Yields decoded frames: { event, id?, data, payload } where payload is the
// parsed JSON body (null when unparseable). Ends cleanly on a `run-terminal`
// frame or an aborted signal; reconnects (resuming from the last seen seq)
// on anything else. Fatal errors (auth, unknown run, invalid cursor) and
// transport exhaustion (maxConsecutiveFailures) throw.
export async function* followRunEvents({
  baseUrl,
  token,
  runId,
  afterSeq = -1,
  signal,
  backoff,
  healthyAfterMs = 1000,
  maxConsecutiveFailures = 20,
  onRetry = () => {},
  fetchImpl = fetch
}) {
  let lastSeq = afterSeq;
  let attempt = 0;
  while (!signal?.aborted) {
    let reachedTerminal = false;
    const connectionStart = Date.now();
    let resetBackoff = false;
    let dropError = null;
    try {
      for await (const frame of streamRunEvents({ baseUrl, token, runId, afterSeq: lastSeq, signal, fetchImpl })) {
        let payload = null;
        if (frame.data) {
          try {
            payload = JSON.parse(frame.data);
          } catch {
            payload = null;
          }
        }
        if (frame.event === "run-event" && typeof payload?.seq === "number") {
          if (payload.seq <= lastSeq) continue; // duplicate after resume — drop
          lastSeq = payload.seq;
        }
        // The `ready` preamble is replay bookkeeping and a deduped duplicate
        // is re-sent history — neither proves a live stream. Mirror the
        // gateway client: only a genuinely fresh frame or sustained liveness
        // resets the backoff counter (dedupe `continue` runs above).
        const isReplayPreamble = frame.event === "ready";
        if (!resetBackoff && (!isReplayPreamble || Date.now() - connectionStart >= healthyAfterMs)) {
          attempt = 0;
          resetBackoff = true;
        }
        if (frame.event === "run-terminal") reachedTerminal = true;
        yield { ...frame, payload };
        if (reachedTerminal) return;
      }
      // Stream ended without a terminal frame: silent drop — reconnect.
    } catch (error) {
      if (signal?.aborted) return;
      if (isFatalStreamError(error)) throw error;
      dropError = error;
    }
    if (signal?.aborted) return;
    if (attempt + 1 >= maxConsecutiveFailures) {
      const error = new Error(
        `stream to ${baseUrl} failed ${attempt + 1} times in a row${dropError ? ` (last: ${dropError.message})` : ""}; giving up`
      );
      error.transport = true;
      throw error;
    }
    onRetry(dropError, attempt, lastSeq);
    await sleepWithSignal(streamBackoffDelay(attempt, backoff), signal);
    attempt += 1;
  }
}
