import { eventNode } from "./runEventClassification.js";
import { RUN_FAILURE_TERMINAL_STATUSES } from "./runFailureClass.js";

// Per-node lifecycle states a flow view can render. Everything here is derived
// from the static workflow graph + the run's persisted events — no state of
// its own, so the flow is always as honest as the event stream.
export const FLOW_NODE_STATES = [
  "pending",
  "active",
  "done",
  "failed",
  "waiting",
  "cancelled",
  "skipped"
];

const NODE_STARTED_RE = /^(?:node|task|step)\.started$|^NodeStarted$/i;
const NODE_DONE_RE = /^(?:node|task|step)\.(?:finished|completed)$|^NodeFinished$/i;
const NODE_FAILED_RE = /^(?:node|task|step)\.(?:failed|errored)$|^NodeFailed$/i;
const NODE_CANCELLED_RE = /^(?:node|task|step)\.cancelled$|^NodeCancelled$/i;
const NODE_SKIPPED_RE = /^(?:node|task|step)\.skipped$/i;

function nodeEventState(type) {
  if (NODE_STARTED_RE.test(type)) return "active";
  if (NODE_DONE_RE.test(type)) return "done";
  if (NODE_FAILED_RE.test(type)) return "failed";
  if (NODE_CANCELLED_RE.test(type)) return "cancelled";
  if (NODE_SKIPPED_RE.test(type)) return "skipped";
  return "";
}

function entryNodeState(run) {
  if (run.status === "waiting_approval") return "waiting";
  if (run.status === "queued") return "pending";
  return "done";
}

// Fold the run's event stream onto the static workflow graph, producing one
// state per node plus the evidence behind it. Rules, in order of authority:
//  1. explicit node lifecycle events (node.started/finished/failed/...);
//  2. an unresolved engine.approval.waiting parks its node in `waiting`;
//  3. the run's own status closes the books — succeeded marks unfinished
//     active nodes done, cancelled cancels them, a failure-terminal status
//     fails the node the run died on, paused/waiting_approval park it.
// Nodes never touched by any rule stay `pending`.
export function buildRunFlow({ run, graph = null, events = [], pendingApprovals = [] }) {
  const sorted = [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const stats = new Map();

  const statFor = (nodeId) => {
    if (!stats.has(nodeId)) {
      stats.set(nodeId, {
        state: "",
        startedAt: null,
        finishedAt: null,
        events: 0,
        errors: 0,
        lastEventAt: null,
        lastEventType: "",
        approvalWaiting: false
      });
    }
    return stats.get(nodeId);
  };

  for (const event of sorted) {
    const type = String(event?.type || "");
    const nodeId = eventNode(event);
    if (!nodeId) continue;
    const stat = statFor(nodeId);
    stat.events += 1;
    stat.lastEventAt = event.createdAt;
    stat.lastEventType = type;
    const state = nodeEventState(type);
    if (state) {
      stat.state = state;
      if (state === "active" && !stat.startedAt) stat.startedAt = event.createdAt;
      if (state !== "active" && state !== "pending") stat.finishedAt = event.createdAt;
    }
    if (NODE_FAILED_RE.test(type)) stat.errors += 1;
    // Engine approvals pause one node until resumed; the latest event wins,
    // mirroring hasEngineApprovalWait in src/db.js.
    if (/^engine\.approval\.waiting$/i.test(type)) stat.approvalWaiting = true;
    if (/^engine\.approval\.(?:resumed|applied)$/i.test(type)) stat.approvalWaiting = false;
  }

  // Nodes referenced by events but missing from the static graph (or when no
  // graph could be derived at all) still render — the flow degrades to an
  // event-derived stepper rather than dropping observed work.
  const knownIds = new Set(graphNodes.map((node) => node.id));
  const extraNodes = [...stats.keys()]
    .filter((nodeId) => !knownIds.has(nodeId))
    .map((nodeId) => ({ id: nodeId, type: "task", kind: "task", label: nodeId, sublabel: "", derivedFromEvents: true }));

  const runFailed = RUN_FAILURE_TERMINAL_STATUSES.has(run.status);
  const nodes = [...graphNodes, ...extraNodes].map((node) => {
    const stat = stats.get(node.id) || null;
    let state = stat?.state || "pending";
    if (node.kind === "entry" || node.type === "entry") {
      state = entryNodeState(run);
    } else if (stat?.approvalWaiting) {
      state = "waiting";
    } else if (state === "active") {
      if (run.status === "succeeded") state = "done";
      else if (run.status === "cancelled") state = "cancelled";
      else if (run.status === "paused" || run.status === "waiting_approval") state = "waiting";
      else if (runFailed) state = "failed";
    } else if (state === "pending" && run.status === "running" && run.currentStep && run.currentStep === node.id) {
      state = "active";
    }
    return {
      ...node,
      state,
      startedAt: stat?.startedAt || null,
      finishedAt: stat?.finishedAt || null,
      events: stat?.events || 0,
      errors: stat?.errors || 0,
      lastEventAt: stat?.lastEventAt || null,
      lastEventType: stat?.lastEventType || ""
    };
  });

  const counts = {};
  for (const state of FLOW_NODE_STATES) counts[state] = 0;
  for (const node of nodes) counts[node.state] = (counts[node.state] || 0) + 1;

  return {
    runId: run.id,
    status: run.status,
    currentStep: run.currentStep || "",
    error: run.error || null,
    pause: run.pause || null,
    name: graph?.name || run.capabilityName || run.capabilitySlug || "Workflow",
    source: graph ? (graph.derivedFrom || "workflow-source") : "events",
    nodes,
    edges: Array.isArray(graph?.edges) ? graph.edges : [],
    counts,
    pendingApprovals: pendingApprovals.map((approval) => ({
      id: approval.id,
      title: approval.title,
      kind: approval.kind,
      createdAt: approval.createdAt
    }))
  };
}
