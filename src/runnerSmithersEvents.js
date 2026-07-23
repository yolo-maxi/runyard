export function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-9;]*m/g, "");
}

export function smithersEventMessage(line) {
  try {
    const parsed = JSON.parse(line);
    return stripAnsi(parsed.data ?? parsed.message ?? line);
  } catch {
    return stripAnsi(line);
  }
}

export function smithersEventsArtifactContent(lines = []) {
  return lines.map(smithersEventMessage).join("\n");
}

// Extract a Hub usage record from one engine event line. The Smithers engine
// emits a structured TokenUsageReported event for every agent result (model,
// node, token counts taken from the agent CLI's own reported usage) — this is
// engine telemetry at the inference boundary, not stdout parsing. Returns the
// POST /api/runs/:id/usage body, or null for any other event line.
export function smithersTokenUsage(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : parsed;
  if ((parsed?.type ?? payload?.type) !== "TokenUsageReported") return null;
  const promptTokens = Math.max(0, Number(payload.inputTokens) || 0);
  const completionTokens = Math.max(0, Number(payload.outputTokens) || 0);
  if (promptTokens + completionTokens === 0) return null;
  const engineRunId = parsed.runId || payload.runId || "";
  const sequence = parsed.seq ?? payload.timestampMs ?? "";
  return {
    model: String(payload.model || "unknown"),
    promptTokens,
    completionTokens,
    source: "runner",
    nodeId: payload.nodeId ? String(payload.nodeId) : null,
    agentLabel: payload.agent ? String(payload.agent) : null,
    // Stable per-call id so a replayed event stream (runner restart/relaunch)
    // never double-counts the same call.
    requestId: engineRunId && sequence !== "" ? `${engineRunId}:${sequence}` : null,
    metadata: {
      ...(payload.iteration !== undefined ? { iteration: payload.iteration } : {}),
      ...(payload.attempt !== undefined ? { attempt: payload.attempt } : {}),
      ...(payload.cacheReadTokens ? { cacheReadTokens: Number(payload.cacheReadTokens) } : {}),
      ...(payload.cacheWriteTokens ? { cacheWriteTokens: Number(payload.cacheWriteTokens) } : {}),
      ...(payload.reasoningTokens ? { reasoningTokens: Number(payload.reasoningTokens) } : {})
    }
  };
}

// Forward only the unseen suffix of Smithers' replayed event history. The
// engine `events` command returns the full stream on every poll, so callers
// carry `posted` across polls and run this once more against the final
// collected stream after the engine becomes terminal. That final flush is
// load-bearing: terminal events (especially TokenUsageReported) can land
// between the last poll and `inspect` observing completion.
export async function forwardSmithersEventTail({
  lines = [],
  posted = 0,
  observeEventLine = () => {},
  postEventLine,
  postUsage,
  gatewayModel = ""
} = {}) {
  for (let i = Math.max(0, Number(posted) || 0); i < lines.length; i++) {
    observeEventLine(lines[i]);
    await postEventLine(lines[i]);
    const usage = smithersTokenUsage(lines[i]);
    if (usage && (!gatewayModel || usage.model !== gatewayModel)) {
      await postUsage(usage);
    }
  }
  return lines.length;
}
