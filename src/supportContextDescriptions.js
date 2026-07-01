import {
  redactContextValue,
  safeSupportInput
} from "./supportContextPresentation.js";
import { summarizeSupportEvents } from "./supportContextEvents.js";

const MAX_FAILING_RUNS = 6;

function runHeadline(run, { redact = redactContextValue } = {}) {
  if (!run) return "";
  if (run.error) return redact(run.error, 200);
  return redact(run.currentStep || "", 160);
}

export function createSupportContextDescribers({
  dashboardStats,
  getApproval,
  getCapability,
  listApprovals,
  listCapabilities,
  listRunEvents,
  listRuns,
  runnerPoolStats,
  redact = redactContextValue,
  safeInput = safeSupportInput
}) {
  function recentRunEvents(runId) {
    return summarizeSupportEvents(listRunEvents(runId));
  }

  function describeRun(run) {
    const lines = [];
    lines.push(`Run ${run.id} — ${run.capabilityName || run.capabilitySlug || "workflow"}`);
    lines.push(`Status: ${run.status}${run.currentStep ? ` (step: ${redact(run.currentStep, 80)})` : ""}`);
    const headline = runHeadline(run, { redact });
    if (headline && headline !== run.currentStep) lines.push(`Detail: ${headline}`);
    const inputSummary = safeInput(run.input);
    if (inputSummary) lines.push(`Input: ${inputSummary}`);
    if (run.createdAt) lines.push(`Created: ${run.createdAt}`);
    if (run.completedAt) lines.push(`Completed: ${run.completedAt}`);
    const events = recentRunEvents(run.id);
    if (events.length) {
      lines.push("Recent events:");
      for (const e of events) lines.push(`  • ${e.type}: ${e.message || "(no message)"}`);
    }
    return lines.join("\n");
  }

  function describeRunsList() {
    const stats = dashboardStats();
    const pool = runnerPoolStats();
    const failing = listRuns({ status: "failed", limit: MAX_FAILING_RUNS });
    const lines = [];
    lines.push(
      `Runs overview — ${stats.runs} total · ${stats.runningRuns} active ` +
      `(${pool.queued} queued, ${pool.running} running, ${pool.waitingApproval} waiting approval) · ` +
      `${stats.pendingApprovals} pending approval${stats.pendingApprovals === 1 ? "" : "s"}.`
    );
    lines.push(
      `Runner pool: ${pool.onlineRunners} online, ${pool.availableSlots}/${pool.totalCapacity} slots free.`
    );
    if (failing.length) {
      lines.push(`Recent failed runs (${failing.length}):`);
      for (const run of failing) {
        lines.push(`  • ${run.id} ${run.capabilitySlug || ""} — ${runHeadline(run, { redact }) || "failed"}`);
      }
    } else {
      lines.push("No failed runs on record.");
    }
    return lines.join("\n");
  }

  function describeWorkflow(slug) {
    const cap = getCapability(slug);
    if (!cap) return `Workflow "${slug}" was not found in this Hub.`;
    const recent = listRuns({ q: cap.slug, limit: 5 }).filter((r) => r.capabilitySlug === cap.slug);
    const lines = [];
    lines.push(`Workflow ${cap.name || cap.slug} (slug: ${cap.slug})`);
    if (cap.category) lines.push(`Category: ${cap.category}`);
    if (cap.description) lines.push(`Description: ${redact(cap.description, 360)}`);
    if (cap.requiredRunnerTags?.length) lines.push(`Required runner tags: ${cap.requiredRunnerTags.join(", ")}`);
    if (recent.length) {
      lines.push("Recent runs:");
      for (const run of recent) lines.push(`  • ${run.id} — ${run.status}`);
    }
    return lines.join("\n");
  }

  function describeWorkflowsList() {
    const caps = listCapabilities();
    const lines = [`Workflows catalog — ${caps.length} installed.`];
    for (const cap of caps.slice(0, 14)) {
      lines.push(`  • ${cap.slug}${cap.category ? ` [${cap.category}]` : ""} — ${redact(cap.description || cap.name || "", 80)}`);
    }
    return lines.join("\n");
  }

  function describeApprovals(segments) {
    const id = segments[1];
    if (id) {
      const approval = getApproval(id);
      if (!approval) return `Approval "${id}" was not found.`;
      const lines = [`Approval ${approval.id} — status ${approval.status}`];
      if (approval.title) lines.push(`Title: ${redact(approval.title, 160)}`);
      if (approval.runId) lines.push(`Run: ${approval.runId}`);
      if (approval.comment) lines.push(`Comment: ${redact(approval.comment, 240)}`);
      return lines.join("\n");
    }
    const pending = listApprovals("pending");
    const lines = [`Pending approvals — ${pending.length}.`];
    for (const approval of pending.slice(0, 8)) {
      lines.push(`  • ${approval.id} — ${redact(approval.title || approval.runId || "approval", 120)}`);
    }
    return lines.join("\n");
  }

  function describeRunners() {
    const pool = runnerPoolStats();
    return [
      `Runner pool — ${pool.onlineRunners}/${pool.runners} online.`,
      `Capacity: ${pool.totalActive}/${pool.totalCapacity} slots in use, ${pool.availableSlots} free.`,
      `Queue: ${pool.queued} queued, ${pool.running} running, ${pool.waitingApproval} waiting approval.`
    ].join("\n");
  }

  return {
    describeApprovals,
    describeRun,
    describeRunners,
    describeRunsList,
    describeWorkflow,
    describeWorkflowsList,
    recentRunEvents
  };
}

export const __test = { runHeadline };
