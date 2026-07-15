// Run → work item status sync: linked runs move their ticket across the
// board where the mapping is reliable, so the factory board reflects what
// workflows are actually doing without an operator shepherding every card.
//
// The mapping is deliberately conservative:
//   - a run starting (queued/assigned/running) puts the ticket In motion —
//     including a blocked ticket, since relaunching is the unblock signal
//     (the stale blockedReason is cleared);
//   - a run held for a human (waiting_approval/paused/budget_exceeded)
//     parks the ticket in waiting ("Needs decision");
//   - a succeeded run moves the ticket to review — never straight to
//     shipped: a human accepts outcomes;
//   - a failed run parks the ticket in blocked with an explicit reason —
//     there is still no "failed" ticket state (the ticket is the durable
//     ask, not one attempt);
//   - a cancelled run moves nothing (cancelling is already an operator act).
//
// Tickets that are done (shipped/accepted/archived) are never touched, and
// terminal run outcomes (succeeded/failed) are ignored while a sibling
// linked run is still live. Every automated move lands in ticket history as
// a status_changed event attributed to the run.

const TICKET_DONE_STATUSES = ["shipped", "accepted", "archived"];
const LIVE_RUN_STATUSES = ["queued", "assigned", "running", "waiting_approval", "paused"];

const RUN_STATUS_MOVES = {
  queued: { to: "running", from: ["intake", "triaged", "ready", "waiting", "review", "blocked"] },
  assigned: { to: "running", from: ["intake", "triaged", "ready", "waiting", "review", "blocked"] },
  running: { to: "running", from: ["intake", "triaged", "ready", "waiting", "review", "blocked"] },
  waiting_approval: { to: "waiting", from: ["intake", "triaged", "ready", "running", "review"] },
  paused: { to: "waiting", from: ["intake", "triaged", "ready", "running", "review"] },
  budget_exceeded: { to: "waiting", from: ["intake", "triaged", "ready", "running", "review"] },
  succeeded: { to: "review", from: ["intake", "triaged", "ready", "running", "waiting"], exclusive: true },
  failed: { to: "blocked", from: ["intake", "triaged", "ready", "running", "waiting"], exclusive: true }
};

// Pure mapping: given the ticket + run statuses, what move (if any) applies?
// Returns { to, clearBlockedReason?, blockedReason? } or null.
export function workItemMoveForRunStatus(ticketStatus, runStatus, runId = "") {
  if (TICKET_DONE_STATUSES.includes(ticketStatus)) return null;
  const move = RUN_STATUS_MOVES[runStatus];
  if (!move || !move.from.includes(ticketStatus)) return null;
  if (ticketStatus === move.to) return null;
  const result = { to: move.to, exclusive: Boolean(move.exclusive) };
  if (ticketStatus === "blocked" && move.to === "running") result.clearBlockedReason = true;
  if (runStatus === "failed") result.blockedReason = `Linked run ${runId} failed`;
  return result;
}

export function createWorkItemRunSync({ getWorkItem, updateWorkItem, listWorkItemRuns }) {
  // run: a normalized run row that carries workItemId + status.
  // Never throws — a sync failure must not break the run mutation it rides on.
  function syncWorkItemForRun(run, { trigger = "run_status" } = {}) {
    try {
      if (!run?.workItemId) return null;
      const ticket = getWorkItem(run.workItemId);
      if (!ticket) return null;
      const move = workItemMoveForRunStatus(ticket.status, run.status, run.id);
      if (!move) return null;
      if (move.exclusive) {
        const siblingLive = listWorkItemRuns(ticket.id).some(
          (linked) => linked.id !== run.id && LIVE_RUN_STATUSES.includes(linked.status)
        );
        if (siblingLive) return null;
      }
      const updates = { status: move.to };
      if (move.blockedReason) updates.blockedReason = move.blockedReason;
      if (move.clearBlockedReason) updates.blockedReason = "";
      return updateWorkItem(ticket.id, updates, {
        actor: `run:${run.id}`,
        reason: `run ${run.status}${trigger === "run_linked" ? " (linked)" : ""}`
      });
    } catch {
      return null;
    }
  }

  return { syncWorkItemForRun };
}
