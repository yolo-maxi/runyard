// Engine-approval bridge (runner side).
//
// A Smithers workflow can pause at an engine-level <Approval> node without any
// Hub involvement: the engine parks the run as `waiting-approval` and waits for
// `smithers approve/deny` on the runner box. Before this bridge those pauses
// were invisible to the Hub — no approval card, no run events — so the stall
// reaper failed them as `run_stalled` and operators saw a dead run instead of a
// pending human decision.
//
// The bridge closes that gap from the runner's existing poll loop:
//  - detect engine approval waits from `smithers inspect` (already polled),
//  - surface each wait as an `engine.approval.waiting` run event plus a Hub
//    approval card (payload kind `engine_approval`),
//  - apply the card's human decision back to the engine via
//    `smithers approve|deny` (fail-closed: a mismatch just errors and the wait
//    — and its hold — persists),
//  - emit `engine.approval.resumed` when the engine moves on, so the Hub can
//    auto-resolve a card that was decided engine-side.
//
// Everything here is best-effort and never throws into the runner loop: the
// Hub-side event-based hold (hasEngineApprovalWait) plus the pending card are
// independent belts, so one failed HTTP call never turns a human pause into a
// terminal failure.

export const ENGINE_APPROVAL_WAITING_EVENT = "engine.approval.waiting";
export const ENGINE_APPROVAL_RESUMED_EVENT = "engine.approval.resumed";
export const ENGINE_APPROVAL_APPLIED_EVENT = "engine.approval.applied";
export const ENGINE_APPROVAL_APPLY_FAILED_EVENT = "engine.approval.apply_failed";
export const ENGINE_APPROVAL_PAYLOAD_KIND = "engine_approval";

// Give up applying a resolved card after this many failed CLI attempts; the
// wait (and the Hub-side hold) persists either way, so an operator can still
// decide engine-side with `smithers approve`.
export const ENGINE_APPROVAL_MAX_APPLY_ATTEMPTS = 3;

// Extract pending engine-level approval waits from `smithers inspect` JSON.
// 0.22.0 shape: { run: {status}, runState?: {state}, approvals?: [{nodeId,
// status, requestedAt}] } — `approvals` lists pending gates only. When the
// engine reports `waiting-approval` but the approvals array is missing (older
// engine, transient lag), a synthetic empty-node wait keeps the run held.
//
// The workflow author's <Approval request={{title, summary, metadata}}> is
// stored by the engine but NOT exposed by 0.22 inspect. We read those fields
// defensively (request.title / title, request.summary / summary, metadata) so
// an engine upgrade that exposes them (≥0.25) makes the Hub card carry the
// authored question with no runner change.
export function engineApprovalWaits(inspect = null) {
  if (!inspect || typeof inspect !== "object") return [];
  const status = String(inspect.runState?.state || inspect.run?.status || "");
  const approvals = Array.isArray(inspect.approvals) ? inspect.approvals : [];
  const waits = approvals
    .filter((approval) => String(approval?.status || "pending") === "pending")
    .map((approval) => {
      const request = approval?.request && typeof approval.request === "object" ? approval.request : {};
      const metadata = request.metadata ?? approval?.metadata;
      return {
        nodeId: String(approval?.nodeId || ""),
        requestedAt: String(approval?.requestedAt || ""),
        title: String(request.title || approval?.title || ""),
        summary: String(request.summary || approval?.summary || ""),
        metadata: metadata && typeof metadata === "object" ? metadata : null
      };
    })
    .filter((wait) => wait.nodeId);
  if (waits.length) return waits;
  if (status === "waiting-approval") return [{ nodeId: "", requestedAt: "", title: "", summary: "", metadata: null }];
  return [];
}

// Hub approval-card request body for one engine-level wait. No timeoutMs:
// engine approvals are blocking by contract (timed approvals are a Hub-native
// concept); the card stays pending until a human or the engine decides.
//
// The card's title/summary/ask come, in preference order, from:
//  1. the gate's own authored request (when the engine exposes it — see
//     engineApprovalWaits),
//  2. the per-workflow gate ask registered at seed time
//     (capability.approvalPolicy.gates[nodeId]),
//  3. honest generic copy naming the workflow and gate.
// The smithers CLI equivalence rides in the payload (ops detail), not in the
// human-facing description.
export function engineApprovalCardRequest({
  hubRunId = "",
  smithersRunId = "",
  nodeId = "",
  capabilitySlug = "",
  runnerName = "",
  wait = {},
  gateAsk = null
} = {}) {
  const nodeLabel = nodeId || "approval";
  const authoredTitle = String(wait?.title || "").trim();
  const authoredSummary = String(wait?.summary || "").trim();
  const registered = gateAsk && typeof gateAsk === "object" ? gateAsk : {};
  const title =
    authoredTitle || String(registered.title || "").trim() || `Workflow gate: ${capabilitySlug || "workflow"} · ${nodeLabel}`;
  const description =
    authoredSummary ||
    String(registered.summary || "").trim() ||
    `The '${capabilitySlug || "workflow"}' workflow paused at its '${nodeLabel}' gate and is waiting for a human decision.`;
  const ask = {
    audience: "operators",
    action:
      String(registered.action || "").trim() ||
      `Resume the '${capabilitySlug || "workflow"}' workflow past its '${nodeLabel}' gate (or send it down the gate's deny path).`,
    reason:
      String(registered.reason || "").trim() ||
      authoredSummary ||
      "The workflow's author marked this step as requiring human sign-off before continuing."
  };
  return {
    runId: hubRunId,
    title: title.slice(0, 240),
    description: description.slice(0, 2000),
    requestedBy: `runner: ${runnerName}`,
    ask,
    payload: {
      kind: ENGINE_APPROVAL_PAYLOAD_KIND,
      approvalKind: "engine_gate",
      approvalScope: "engine_node",
      capability: capabilitySlug,
      smithersRunId,
      nodeId,
      runnerName,
      notifyTelegram: true,
      // Authored request context (when the engine exposed it) so the Hub can
      // render the gate's own words even if title/description get edited.
      ...(authoredTitle || authoredSummary || wait?.metadata
        ? {
            request: {
              ...(authoredTitle ? { title: authoredTitle } : {}),
              ...(authoredSummary ? { summary: authoredSummary } : {}),
              ...(wait?.metadata ? { metadata: wait.metadata } : {})
            }
          }
        : {}),
      // Ops remediation detail (kept out of the human-facing description):
      // deciding engine-side on the runner is always possible.
      engineCli: `smithers approve|deny ${smithersRunId}${nodeId ? ` --node ${nodeId}` : ""}`
    }
  };
}

// argv for applying a resolved Hub card to the engine. approved → approve;
// rejected / changes_requested → deny (the engine has no "changes" concept —
// a deny fails the gate and the workflow decides what that means). Unknown
// decisions return null: never invent an engine decision.
export function engineApprovalCliArgs({ decision = "", smithersRunId = "", nodeId = "", resolvedBy = "", comment = "" } = {}) {
  const normalized = String(decision || "").trim().toLowerCase();
  const command = normalized === "approved" ? "approve" : normalized === "rejected" || normalized === "changes_requested" ? "deny" : "";
  if (!command || !smithersRunId) return null;
  const args = [command, smithersRunId];
  if (nodeId) args.push("--node", nodeId);
  if (resolvedBy) args.push("--by", String(resolvedBy).slice(0, 120));
  if (comment) args.push("--note", String(comment).slice(0, 500));
  return args;
}

// Observe an engine-side approval decision in a streamed NDJSON event line
// (`smithers events --json`: {type, payload: {nodeId, ...}}). Used to mirror
// decisions made directly via the smithers CLI back onto the Hub card.
export function engineDecisionFromEventLine(line) {
  try {
    const parsed = JSON.parse(line);
    const type = String(parsed?.type || "");
    const decision =
      type === "ApprovalGranted" || type === "ApprovalAutoApproved"
        ? "approved"
        : type === "ApprovalDenied"
          ? "rejected"
          : "";
    if (!decision) return null;
    return { nodeId: String(parsed?.payload?.nodeId ?? parsed?.nodeId ?? ""), decision };
  } catch {
    return null;
  }
}

export function createEngineApprovalBridge({
  hubRunId,
  smithersRunId,
  capabilitySlug = "",
  runnerName = "",
  // Seed-time gate asks, keyed by <Approval> node id — the workflow's declared
  // question for each gate (capability.approvalPolicy.gates). Used whenever
  // the engine's inspect does not expose the authored request (0.22 doesn't).
  gateAsks = {},
  postEvent,
  hubGet,
  hubPost,
  runSmithers,
  logError = () => {}
} = {}) {
  // nodeId -> { approvalId, applied, appliedDecision, applyAttempts, applyGaveUp }
  const waits = new Map();
  // nodeId -> engine-side decision observed in the event stream
  const engineDecisions = new Map();

  function observeEventLine(line) {
    const observed = engineDecisionFromEventLine(line);
    if (observed) engineDecisions.set(observed.nodeId, observed.decision);
  }

  async function surfaceWait(wait) {
    const nodeId = wait.nodeId;
    const state = { approvalId: "", applied: false, appliedDecision: "", applyAttempts: 0, applyGaveUp: false };
    waits.set(nodeId, state);
    await postEvent(
      ENGINE_APPROVAL_WAITING_EVENT,
      `Workflow paused at engine-level approval node '${nodeId || "approval"}'; waiting for a human decision.`,
      { smithersRunId, nodeId }
    );
    try {
      const created = await hubPost(
        "/api/approvals",
        engineApprovalCardRequest({
          hubRunId,
          smithersRunId,
          nodeId,
          capabilitySlug,
          runnerName,
          wait,
          gateAsk: (gateAsks && typeof gateAsks === "object" ? gateAsks[nodeId] : null) || null
        })
      );
      state.approvalId = created?.approval?.id || "";
    } catch (error) {
      // The engine.approval.waiting event above is an independent hold on the
      // Hub, so a failed card creation degrades to "held but cardless".
      logError(`engine approval card creation failed for ${hubRunId}/${nodeId}: ${error.message || error}`);
    }
  }

  async function applyResolvedCard(nodeId, state) {
    let approval = null;
    try {
      approval = (await hubGet(`/api/approvals/${state.approvalId}`))?.approval || null;
    } catch {
      return; // transient Hub read failure; retry next tick
    }
    if (!approval || approval.status === "pending") return;
    const args = engineApprovalCliArgs({
      decision: approval.decision,
      smithersRunId,
      nodeId,
      resolvedBy: approval.resolvedBy || "hub-approval",
      comment: approval.comment || ""
    });
    if (!args) {
      // Resolved without a recognizable decision — do not guess. The wait (and
      // hold via the waiting event) persists for an engine-side decision.
      state.applied = true;
      await postEvent(
        ENGINE_APPROVAL_APPLY_FAILED_EVENT,
        `Approval card ${state.approvalId} resolved without an applicable decision (${approval.decision || "none"}); leaving the engine gate for a direct smithers decision.`,
        { smithersRunId, nodeId, approvalId: state.approvalId, decision: approval.decision || "" }
      );
      return;
    }
    state.applyAttempts += 1;
    try {
      await runSmithers(args);
      state.applied = true;
      state.appliedDecision = String(approval.decision || "");
      await postEvent(
        ENGINE_APPROVAL_APPLIED_EVENT,
        `Applied human decision '${approval.decision}' to engine approval node '${nodeId || "approval"}' via smithers ${args[0]}.`,
        { smithersRunId, nodeId, approvalId: state.approvalId, decision: approval.decision }
      );
    } catch (error) {
      const gaveUp = state.applyAttempts >= ENGINE_APPROVAL_MAX_APPLY_ATTEMPTS;
      state.applyGaveUp = gaveUp;
      await postEvent(
        ENGINE_APPROVAL_APPLY_FAILED_EVENT,
        `smithers ${args[0]} failed for approval node '${nodeId || "approval"}' (attempt ${state.applyAttempts}/${ENGINE_APPROVAL_MAX_APPLY_ATTEMPTS}): ${String(error.message || error).slice(0, 500)}` +
          (gaveUp ? " — giving up; decide directly with the smithers CLI on the runner." : ""),
        { smithersRunId, nodeId, approvalId: state.approvalId, attempt: state.applyAttempts }
      );
    }
  }

  async function tick(inspect) {
    try {
      const current = engineApprovalWaits(inspect);
      const currentIds = new Set(current.map((wait) => wait.nodeId));
      for (const wait of current) {
        if (!waits.has(wait.nodeId)) await surfaceWait(wait);
      }
      for (const [nodeId, state] of waits) {
        if (!currentIds.has(nodeId)) continue;
        if (state.approvalId && !state.applied && !state.applyGaveUp) await applyResolvedCard(nodeId, state);
      }
      for (const [nodeId, state] of [...waits]) {
        if (currentIds.has(nodeId)) continue;
        waits.delete(nodeId);
        const engineDecision = engineDecisions.get(nodeId) || state.appliedDecision || "";
        await postEvent(
          ENGINE_APPROVAL_RESUMED_EVENT,
          `Engine approval node '${nodeId || "approval"}' resolved${engineDecision ? ` (${engineDecision})` : ""}; workflow resumed.`,
          { smithersRunId, nodeId, approvalId: state.approvalId, engineDecision }
        );
      }
    } catch (error) {
      // Never let bridge bookkeeping break the streaming loop.
      logError(`engine approval bridge tick failed for ${hubRunId}: ${error.message || error}`);
    }
  }

  return { observeEventLine, tick };
}
