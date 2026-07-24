// `runyard run --follow` / `runyard logs --follow` orchestration: attach to a
// run's SSE stream, render events to stdout (human lines or NDJSON envelopes),
// and exit with a code that distinguishes workflow outcome from
// auth/transport faults.
//
// stdout contract (stable):
//   text mode    one `[createdAt] type: message` line per event, then a short
//                terminal summary block.
//   --json mode  one NDJSON envelope per line, nothing else:
//                  {"kind":"run-created", run, links}      (run --follow only)
//                  {"kind":"event", runId, seq, id, type, message, createdAt, data}
//                  {"kind":"terminal", runId, status, exitCode, error?, output?, links}
// stderr carries every diagnostic: attach/reconnect notices, retry backoff,
// and the Ctrl-C detach message. Nothing secret is ever printed — stream URLs
// are path-only and auth rides the Authorization header.
//
// Exit codes (stable, documented in docs and --help):
//   0    run reached `succeeded`
//   1    run reached any other terminal status (failed, cancelled, timed_out, …)
//   2    usage / input errors (unknown run, invalid cursor)
//   3    transport failure: could not reach or keep a stream to the hub
//   4    authentication/authorization failure
//   130  interrupted (Ctrl-C) — detached WITHOUT cancelling the remote run

import { followRunEvents, isAuthStreamError } from "./sseClient.js";

export const FOLLOW_EXIT = {
  SUCCESS: 0,
  RUN_FAILED: 1,
  USAGE: 2,
  TRANSPORT: 3,
  AUTH: 4,
  INTERRUPTED: 130
};

export function exitCodeForRunStatus(status) {
  return status === "succeeded" ? FOLLOW_EXIT.SUCCESS : FOLLOW_EXIT.RUN_FAILED;
}

export function followEventEnvelope(event) {
  return {
    kind: "event",
    runId: event.runId,
    seq: event.seq,
    id: event.id,
    type: event.type,
    message: event.message || "",
    createdAt: event.createdAt,
    ...(event.data && Object.keys(event.data).length ? { data: event.data } : {})
  };
}

export function followTerminalEnvelope({ runId, status, run = null, links = {} }) {
  return {
    kind: "terminal",
    runId,
    status,
    exitCode: exitCodeForRunStatus(status),
    ...(run?.error ? { error: run.error } : {}),
    ...(run?.output !== undefined && run?.output !== null ? { output: run.output } : {}),
    links
  };
}

// Text mode prints run-supplied content into the operator's terminal:
// scrub every control character (C0/C1, incl. ESC — cursor moves, OSC title
// writes, etc.) so a malicious workflow cannot drive the terminal. JSON mode
// needs no scrub — JSON.stringify escapes control characters.
function sanitizeTerminalText(value) {
  // eslint-disable-next-line no-control-regex
  return String(value || "").replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, " ");
}

export function formatFollowEventLine(event) {
  return `[${event.createdAt}] ${sanitizeTerminalText(event.type)}: ${sanitizeTerminalText(event.message).replace(/\s+$/, "")}`;
}

export function followRunLinks(runId) {
  return {
    statusUrl: `/api/runs/${runId}`,
    logsUrl: `/api/runs/${runId}/logs`,
    artifactsUrl: `/api/runs/${runId}/artifacts`,
    eventsStreamUrl: `/api/runs/${runId}/events/stream`,
    webUrl: `/app#runs/${runId}`
  };
}

function classifyFollowError(error) {
  if (isAuthStreamError(error)) return FOLLOW_EXIT.AUTH;
  if (error?.status === 404 || error?.status === 400) return FOLLOW_EXIT.USAGE;
  return FOLLOW_EXIT.TRANSPORT;
}

// Attach to `runId` and stream through terminal state. Returns
// { exitCode, status } — the caller owns process.exit / SIGINT wiring.
export async function followRun({
  baseUrl,
  token,
  runId,
  afterSeq = -1,
  json = false,
  out = process.stdout,
  err = process.stderr,
  signal,
  fetchImpl = fetch,
  getRunDetail = null,
  backoff,
  maxConsecutiveFailures
}) {
  const writeOut = (line) => out.write(`${line}\n`);
  const writeErr = (line) => err.write(`${line}\n`);
  let terminalStatus = null;
  let lastSeq = afterSeq;

  try {
    const frames = followRunEvents({
      baseUrl,
      token,
      runId,
      afterSeq,
      signal,
      backoff,
      maxConsecutiveFailures,
      fetchImpl,
      onRetry: (error, attempt, seq) => {
        writeErr(`[runyard] stream dropped${error ? ` (${error.message})` : ""}; reconnecting from seq ${seq} (attempt ${attempt + 1})`);
      }
    });
    for await (const frame of frames) {
      if (frame.event === "ready") {
        writeErr(`[runyard] attached to run ${runId} (server has ${frame.payload?.count ?? "?"} events, cursor ${lastSeq})`);
        continue;
      }
      if (frame.event === "run-event" && frame.payload) {
        if (typeof frame.payload.seq === "number") lastSeq = frame.payload.seq;
        if (json) writeOut(JSON.stringify(followEventEnvelope(frame.payload)));
        else writeOut(formatFollowEventLine(frame.payload));
        continue;
      }
      if (frame.event === "run-terminal") {
        // A terminal frame with a corrupt payload still means the run ended;
        // "unknown" maps to exit 1 rather than misreporting a detach.
        terminalStatus = frame.payload?.status || "unknown";
      }
    }
  } catch (error) {
    if (signal?.aborted) return { exitCode: FOLLOW_EXIT.INTERRUPTED, status: null };
    const exitCode = classifyFollowError(error);
    writeErr(`[runyard] follow failed: ${error.message}`);
    return { exitCode, status: null };
  }
  if (signal?.aborted) return { exitCode: FOLLOW_EXIT.INTERRUPTED, status: null };
  if (!terminalStatus) {
    // Stream generator returned without a terminal frame and without throwing
    // — only possible when the signal aborted between checks.
    return { exitCode: FOLLOW_EXIT.INTERRUPTED, status: null };
  }

  // Terminal summary: best-effort run detail for output/error; the exit code
  // never depends on this fetch succeeding.
  let run = null;
  if (getRunDetail) {
    try {
      run = (await getRunDetail(runId))?.run || null;
    } catch {
      run = null;
    }
  }
  const envelope = followTerminalEnvelope({
    runId,
    status: terminalStatus,
    run,
    links: followRunLinks(runId)
  });
  if (json) {
    writeOut(JSON.stringify(envelope));
  } else {
    writeOut(`Run ${runId} finished: ${terminalStatus}`);
    if (run?.error) writeOut(`Error: ${sanitizeTerminalText(String(run.error).slice(0, 2000))}`);
    writeOut(`Status: runyard run-status ${runId}`);
    writeOut(`Artifacts: runyard artifacts ${runId}`);
  }
  return { exitCode: envelope.exitCode, status: terminalStatus };
}
