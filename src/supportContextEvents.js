import { redactContextValue } from "./supportContextPresentation.js";

export const SUPPORT_CONTEXT_MAX_EVENTS = 8;

const FOCUS_EVENT_RE = /(?:^run\.|^node\.|^task\.|^step\.|^workflow\.step|^approval\.|failed|error|cancelled|succeeded|started|finished|completed)/i;
const NOISE_EVENT_RE = /(heartbeat|\.tick$|\.ping$|trace|\.delta$|\.chunk$|tool_use|tool_result|thinking)/i;

export function isSupportContextEvent(event) {
  const type = String(event?.type || "");
  if (NOISE_EVENT_RE.test(type)) return false;
  return FOCUS_EVENT_RE.test(type) || /(error|failed|fatal|panic|exception|timeout|warn)/i.test(String(event?.message || ""));
}

// Pull the most informative recent events for a run: prefer lifecycle / error
// transitions over the firehose of traces and heartbeats.
export function summarizeSupportEvents(events = [], { max = SUPPORT_CONTEXT_MAX_EVENTS } = {}) {
  if (!events.length) return [];
  const focus = events.filter(isSupportContextEvent);
  const chosen = (focus.length ? focus : events).slice(-max);
  return chosen.map((event) => ({
    type: event.type,
    message: redactContextValue(event.message, 200),
    at: event.createdAt
  }));
}
