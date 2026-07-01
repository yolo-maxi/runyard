// Server-side live context for the in-app support agent.
//
// The browser only sends a thin route descriptor ({view, hash, params, ...}).
// That tells us WHERE the operator is, not WHAT they are looking at. This
// module resolves the route against the Hub database (read-only) and builds a
// compact, redacted "Live app data" block so the agent can answer questions
// like "why did this fail?" or "what's broken?" from the actual run/event
// state instead of guessing.
//
// Hard rules:
//   - Read-only. We never write through these helpers.
//   - Never emit token/secret values. Event/log text is redacted and run input
//     is summarized through `safeInput` (secret-shaped keys are dropped).
//   - Bounded. Every list is capped and every string is truncated so the block
//     stays small enough to prepend to the model prompt cheaply.

import {
  dashboardStats,
  getApproval,
  getCapability,
  getRun,
  listApprovals,
  listCapabilities,
  listRunEvents,
  listRuns,
  runnerPoolStats
} from "./db.js";
import {
  parseSupportRoute,
  redactContextValue,
  safeSupportInput
} from "./supportContextPresentation.js";
import { createSupportContextDescribers } from "./supportContextDescriptions.js";

const redact = redactContextValue;
const safeInput = safeSupportInput;

export const parseRoute = parseSupportRoute;

const {
  describeApprovals,
  describeRun,
  describeRunners,
  describeRunsList,
  describeWorkflow,
  describeWorkflowsList,
  recentRunEvents
} = createSupportContextDescribers({
  dashboardStats,
  getApproval,
  getCapability,
  listApprovals,
  listCapabilities,
  listRunEvents,
  listRuns,
  runnerPoolStats,
  redact,
  safeInput
});

// Build the live-context text block. Returns { text, kind } where kind is the
// resolved subject so callers can log/branch. Never throws — any DB hiccup
// degrades to an empty block so chat still works.
export function buildSupportLiveContext(context = {}) {
  try {
    const { view, segments } = parseRoute(context);
    if (view === "runs" || view === "home") {
      const runId = view === "runs" ? segments[1] : "";
      if (runId) {
        const run = getRun(runId);
        if (run) return { kind: "run", text: describeRun(run) };
        return { kind: "run-missing", text: `Run "${runId}" was not found in this Hub.` };
      }
      return { kind: "runs", text: describeRunsList() };
    }
    if (view === "workflows") {
      const slug = segments[1];
      if (slug) return { kind: "workflow", text: describeWorkflow(slug) };
      return { kind: "workflows", text: describeWorkflowsList() };
    }
    if (view === "approvals") return { kind: "approvals", text: describeApprovals(segments) };
    if (view === "runners") return { kind: "runners", text: describeRunners() };
    return { kind: view || "unknown", text: "" };
  } catch {
    return { kind: "error", text: "" };
  }
}

export const __test = { parseRoute, safeInput, redact, recentRunEvents, describeRun, buildSupportLiveContext };
