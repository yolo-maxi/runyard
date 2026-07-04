import { parseMaybeJson } from "./dbNormalization.js";
import { normalizeRun } from "./runRecords.js";
import { runReapReason } from "./runQueryRecords.js";
import { decideReconcile, buildEscalationApproval, HUB_DEFAULT_CAPS } from "./hubSupervisor.js";
import { RUN_TERMINAL } from "./runLifecyclePolicy.js";
import {
  activeReapCandidatesQuery,
  engineApprovalHoldEventsQuery,
  engineApprovalHoldFromEvents,
  failedRecoverableCandidatesQuery,
  normalizeRunLineage,
  pendingRunApprovalQuery,
  repairDispatchedUpdateQuery,
  resumeCheckpointEventQuery,
  resumeCheckpointFromEvent,
  runLineageInsertQuery,
  runLineageListQuery,
  runLineageRecord,
  runProgressMarkerQuery,
  supervisingParentId,
  supervisingParentStatusQuery,
  supervisedChildTerminalCandidatesQuery,
  supervisorMetaUpdateQuery,
  supervisorRunLookupQuery,
  supervisorRunStatusInputQuery,
  waitingApprovalBelongsToParent,
  waitingApprovalInputsQuery
} from "./runSupervisorRecords.js";
import {
  clearAwaitingRepairMeta,
  markRepairDispatchedMeta,
  markTerminalMeta,
  readSupervisorMeta
} from "./runSupervisorMeta.js";
import { createRunSupervisorRequeue } from "./runSupervisorRequeue.js";

function json(value, fallback = null) {
  if (value === undefined) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

export function createRunSupervisorStore({
  all,
  one,
  run,
  id,
  now,
  env,
  transitionRun,
  addRunEvent,
  adjustRunnerActiveRuns,
  createApproval,
  dateNow = Date.now
}) {
  function hasWaitingApprovalSupervisedChild(parentRunId) {
    if (!parentRunId) return false;
    const query = waitingApprovalInputsQuery();
    return all(query.sql, query.params).some((row) => waitingApprovalBelongsToParent(row, parentRunId));
  }

  function hasPendingRunApproval(runId) {
    if (!runId) return false;
    const query = pendingRunApprovalQuery(runId);
    return Boolean(one(query.sql, query.params));
  }

  // Engine-level approval pause, as reported by the runner's approval bridge
  // (engine.approval.waiting / engine.approval.resumed run events). This is the
  // conservative belt under the bridge's Hub approval card: even when card
  // creation failed, the waiting event alone keeps the run from being reaped.
  function hasEngineApprovalWait(runId) {
    if (!runId) return false;
    const query = engineApprovalHoldEventsQuery(runId);
    return engineApprovalHoldFromEvents(all(query.sql, query.params));
  }

  // A run is "approval-held" while a human decision is pending: an unresolved
  // approval card on the run itself, (run-smithers) a supervised child parked
  // in waiting_approval, or an engine-level Smithers <Approval> pause surfaced
  // by the runner. Held runs are exempt from age-based reaping and runner
  // deadlines — approvals block indefinitely by contract.
  function runApprovalHold(run) {
    if (!run || !run.id) return false;
    if (hasPendingRunApproval(run.id)) return true;
    const slug = run.capability_slug ?? run.capabilitySlug ?? "";
    if (slug === "run-smithers" && hasWaitingApprovalSupervisedChild(run.id)) return true;
    return hasEngineApprovalWait(run.id);
  }

  function runResumeCheckpoint(runId) {
    const query = resumeCheckpointEventQuery(runId);
    return resumeCheckpointFromEvent(one(query.sql, query.params));
  }

  function runProgressMarker(runId) {
    const query = runProgressMarkerQuery(runId);
    return one(query.sql, query.params).n;
  }

  function hasLiveSupervisingParent(input) {
    const parentRunId = supervisingParentId(input);
    if (!parentRunId) return false;
    const query = supervisingParentStatusQuery(parentRunId);
    const parent = one(query.sql, query.params);
    if (!parent) return false;
    return !RUN_TERMINAL.has(parent.status);
  }

  function recordRunLineage(runId, entry = {}) {
    const row = runLineageRecord({ id: id("lin"), runId, entry, timestamp: now() });
    const query = runLineageInsertQuery();
    run(query.sql, row);
    return row;
  }

  function listRunLineage(runId) {
    const query = runLineageListQuery(runId);
    return all(query.sql, query.params).map(normalizeRunLineage);
  }

  const {
    requeueRunForResume,
    requeueRunFresh
  } = createRunSupervisorRequeue({
    run,
    now,
    adjustRunnerActiveRuns,
    addRunEvent,
    recordRunLineage,
    runProgressMarker
  });

  function reconcileRepairChildTerminal(repairRunId) {
    if (!repairRunId) return null;
    const repairQuery = supervisorRunStatusInputQuery(repairRunId);
    const repair = one(repairQuery.sql, repairQuery.params);
    if (!repair || !RUN_TERMINAL.has(repair.status)) return null;
    const origin = parseMaybeJson(repair.input, {})?.__origin || {};
    if (origin.type !== "hub-supervisor-repair") return null;
    const parentId = origin.repairsRunId || "";
    if (!parentId) return null;
    const parentQuery = supervisorRunLookupQuery(parentId);
    const parent = one(parentQuery.sql, parentQuery.params);
    if (!parent) return null;
    const meta = readSupervisorMeta(parent);
    if (!meta.awaitingRepair) return null;
    if (meta.repairChildRunId && meta.repairChildRunId !== String(repairRunId)) return null;
    const fingerprint = meta.lastFingerprint || "";

    if (repair.status === "succeeded") {
      addRunEvent(parent.id, "run.supervisor.repair_succeeded", `Code repair ${repairRunId} succeeded; re-running from a clean state`, { repairRunId, fingerprint });
      const requeued = requeueRunFresh(parent, { fingerprint, reason: "workflow-code repair applied; re-running fresh against the fix" });
      return { action: requeued ? "rerun" : "noop", parentId, repairRunId };
    }

    const updatedMeta = clearAwaitingRepairMeta(meta);
    const metaUpdate = supervisorMetaUpdateQuery({ runId: parent.id, meta: json(updatedMeta, {}) });
    run(metaUpdate.sql, metaUpdate.params);
    const decision = {
      action: "escalate",
      escalation: "code_repair_failed",
      fingerprint,
      attempt: Number(parent.attempt) || 0,
      reason: `automated code repair run ${repairRunId} ended '${repair.status}'; operator review required`
    };
    finalizeSupervisorTerminal(parent, decision, "failed", { escalate: true });
    return { action: "escalate", parentId, repairRunId };
  }

  function reconcileSupervisedChildTerminals({ limit = 100 } = {}) {
    const query = supervisedChildTerminalCandidatesQuery({ limit });
    const rows = all(query.sql, query.params);
    const acted = [];
    for (const row of rows) {
      const childId = row.child_id;
      const childStatus = row.child_status;
      const childError = row.child_error || "";
      let result;
      if (childStatus === "succeeded") {
        result = transitionRun(row.id, "succeeded", {
          current_step: "supervised child completed",
          output: {
            supervisedChildRunId: childId,
            childStatus,
            childOutput: parseMaybeJson(row.child_output, null)
          },
          completed_at: now()
        });
      } else if (childStatus === "cancelled") {
        result = transitionRun(row.id, "cancelled", {
          current_step: "supervised child cancelled",
          completed_at: now()
        });
      } else {
        result = transitionRun(row.id, childStatus, {
          current_step: `supervised child ${childStatus}`,
          error: childError || `supervised child ${childId} ended '${childStatus}'`,
          completed_at: now()
        });
      }
      if (!result.ok || result.idempotent) continue;
      addRunEvent(row.id, "run.supervision.child_terminal_reconciled", `Supervised child ${childId} ended '${childStatus}'; parent reconciled`, {
        childRunId: childId,
        childStatus
      });
      acted.push(row.id);
    }
    return acted;
  }

  function finalizeSupervisorTerminal(row, decision, observedStatus, { escalate = false, failError = "", failStep = "" } = {}) {
    const meta = markTerminalMeta(readSupervisorMeta(row), decision);
    const query = supervisorMetaUpdateQuery({ runId: row.id, meta: json(meta, {}) });
    run(query.sql, query.params);

    recordRunLineage(row.id, {
      attempt: Number(row.attempt) || 0,
      action: decision.action,
      reason: decision.reason,
      fingerprint: decision.fingerprint || "",
      prevRunnerId: row.runner_id,
      checkpoint: null
    });

    let endedTerminal = false;
    if (observedStatus === "assigned" || observedStatus === "running") {
      const t = transitionRun(row.id, "failed", {
        current_step: escalate ? "escalated to operator" : failStep || "failed",
        error: escalate ? decision.reason : failError || decision.reason,
        completed_at: now()
      });
      endedTerminal = Boolean(t.ok && !t.idempotent);
      if (endedTerminal && !escalate) {
        addRunEvent(row.id, "run.failed", failError || decision.reason, { reason: "runner_offline" });
      }
    }

    if (escalate) {
      const card = buildEscalationApproval(row, decision);
      createApproval({ runId: row.id, title: card.title, description: card.description, requestedBy: "system:hub-supervisor", payload: card.payload });
      addRunEvent(row.id, "run.supervisor.escalated", card.description, { escalation: decision.escalation, fingerprint: decision.fingerprint });
    }
    return endedTerminal;
  }

  function adjudicateRun(row, { reason, error, observedStatus, currentStep = "", dispatchRepair = null } = {}) {
    const input = parseMaybeJson(row.input, {});

    if (hasLiveSupervisingParent(input)) {
      if (observedStatus === "assigned" || observedStatus === "running") {
        const t = transitionRun(row.id, "failed", { current_step: currentStep || "runner offline", error, completed_at: now() });
        if (t.ok && !t.idempotent) addRunEvent(row.id, "run.failed", error, { reason });
        return { action: "give_up", endedTerminal: Boolean(t.ok && !t.idempotent) };
      }
      return { action: "give_up", endedTerminal: false };
    }

    const checkpoint = runResumeCheckpoint(row.id);
    const meta = readSupervisorMeta(row);
    const cancelledIntent = observedStatus === "cancelled" || row.status === "cancelled";

    const decision = decideReconcile({
      reason,
      error,
      checkpoint,
      cancelledIntent,
      attempt: Number(row.attempt) || 0,
      repairCount: Number(row.repair_count) || 0,
      repairedFingerprints: meta.repairedFingerprints,
      fingerprintResumes: meta.fingerprintResumes,
      progressMarker: runProgressMarker(row.id),
      lastProgressMarker: meta.lastProgressMarker,
      enableRepair: Boolean(dispatchRepair),
      caps: HUB_DEFAULT_CAPS
    });

    if (decision.action === "repair" && dispatchRepair) {
      let repairChildId = "";
      try {
        const out = dispatchRepair(normalizeRun(row), decision, checkpoint);
        repairChildId = typeof out === "string" ? out : out && out.id ? String(out.id) : out ? "pending" : "";
      } catch {
        repairChildId = "";
      }
      if (repairChildId) {
        const fp = decision.fingerprint || "";
        const repairMeta = markRepairDispatchedMeta(meta, { fingerprint: fp, repairChildRunId: repairChildId });
        const query = repairDispatchedUpdateQuery({
          runId: row.id,
          repairCount: (Number(row.repair_count) || 0) + 1,
          meta: json(repairMeta, {})
        });
        run(query.sql, query.params);
        recordRunLineage(row.id, { attempt: Number(row.attempt) || 0, action: "repair", reason: decision.reason, fingerprint: fp, prevRunnerId: row.runner_id, checkpoint });
        addRunEvent(row.id, "run.supervisor.repair_dispatched", decision.reason, { fingerprint: fp, repairChildRunId: repairMeta.repairChildRunId });
        return { action: "repair", endedTerminal: false, resumed: false };
      }
      return { action: "escalate", endedTerminal: finalizeSupervisorTerminal(row, { ...decision, action: "escalate", escalation: "code_repair_undispatched" }, observedStatus, { escalate: true }) };
    }

    if (decision.action === "resume") {
      const resumed = requeueRunForResume(row, decision, checkpoint, observedStatus);
      return { action: resumed ? "resume" : "noop", endedTerminal: false };
    }

    if (decision.action === "escalate") {
      return { action: "escalate", endedTerminal: finalizeSupervisorTerminal(row, decision, observedStatus, { escalate: true }) };
    }

    return {
      action: "give_up",
      endedTerminal: finalizeSupervisorTerminal(row, decision, observedStatus, { escalate: false, failError: error, failStep: currentStep })
    };
  }

  function reapStuckRunIds(maxMs) {
    const nowMs = dateNow();
    const query = activeReapCandidatesQuery();
    const active = all(query.sql, query.params);
    const reaped = [];
    for (const row of active) {
      const reason = runReapReason(row, {
        maxMs,
        stallMs: env.runStallMs,
        runnerOfflineMs: env.runnerOfflineMs,
        nowMs,
        hasPendingApproval: hasPendingRunApproval,
        hasWaitingApprovalSupervisedChild,
        hasEngineApprovalWait
      });
      if (!reason) continue;
      if (reason.reason === "runner_offline") {
        const outcome = adjudicateRun(row, { reason: "runner_offline", error: reason.error, currentStep: reason.currentStep, observedStatus: row.status });
        if (outcome.endedTerminal) reaped.push(row.id);
        continue;
      }
      const result = transitionRun(row.id, "failed", { current_step: reason.currentStep, error: reason.error, completed_at: now() });
      if (result.ok && !result.idempotent) {
        addRunEvent(row.id, "run.failed", reason.message, { reason: reason.reason });
        reaped.push(row.id);
      }
    }
    return reaped;
  }

  function reconcileFailedRecoverable({ dispatchRepair = null, limit = 25, lookbackMs = 6 * 60 * 60_000 } = {}) {
    const since = new Date(dateNow() - lookbackMs).toISOString();
    const query = failedRecoverableCandidatesQuery({ since, limit });
    const candidates = all(query.sql, query.params);
    const acted = [];
    for (const row of candidates) {
      const meta = readSupervisorMeta(row);
      if (meta.adjudicated) continue;
      if (meta.awaitingRepair) {
        if (meta.repairChildRunId) {
          const childQuery = supervisingParentStatusQuery(meta.repairChildRunId);
          const child = one(childQuery.sql, childQuery.params);
          if (child && RUN_TERMINAL.has(child.status)) {
            const out = reconcileRepairChildTerminal(meta.repairChildRunId);
            if (out && out.action && out.action !== "noop") acted.push(row.id);
          }
        }
        continue;
      }
      if (!runResumeCheckpoint(row.id)) continue;
      const outcome = adjudicateRun(row, {
        reason: row.failure_reason || "failed",
        error: row.error || "",
        observedStatus: "failed",
        dispatchRepair
      });
      if (outcome.action === "resume" || outcome.action === "repair" || outcome.action === "escalate") acted.push(row.id);
    }
    return acted;
  }

  return {
    recordRunLineage,
    listRunLineage,
    reconcileRepairChildTerminal,
    reconcileSupervisedChildTerminals,
    reapStuckRunIds,
    reapStuckRuns: (maxMs) => reapStuckRunIds(maxMs).length,
    reconcileFailedRecoverable,
    hasEngineApprovalWait,
    runApprovalHold
  };
}
