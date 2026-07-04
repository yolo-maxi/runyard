import { deepLinks } from "./deepLinks.js";
import { now } from "./ids.js";
import { executionIntentFromInput } from "./runExecution.js";
import { classifyFailureStatus, failureEventType, normalizeFailureStatus } from "./runFailureClass.js";
import { requestOrigin } from "./requestContext.js";
import {
  chainMetadata,
  nextChainedRunInput,
  nextChainedRunOrigin
} from "./workflowChain.js";

export function createRunLifecycleHandlers({
  addRunEvent,
  createRun,
  getCapability,
  maybeRecordFailureClassAlert,
  recordRunTerminalArtifacts,
  resolveEngineApprovalOnResume = () => [],
  scrubStoredSecrets,
  transitionRun,
  updateRun,
  withRunLinks
} = {}) {
  function queueNextChainedRun(parentRun, output, req) {
    const { chain, index } = chainMetadata(parentRun.input || {});
    const next = chain[index];
    if (!next) {
      if (chain.length > 0) addRunEvent(parentRun.id, "run.chain.completed", "Workflow chain completed", { chainLength: chain.length });
      return null;
    }
    const capability = getCapability(next.capability);
    if (!capability || !capability.enabled) {
      addRunEvent(parentRun.id, "run.chain.failed", `Next chained capability not found: ${next.capability}`, { capability: next.capability, index });
      return null;
    }
    const nextInput = nextChainedRunInput({ parentRun, output, chain, index, next });
    const origin = requestOrigin(req, {
      origin: nextChainedRunOrigin(parentRun, chain, index)
    });
    const child = createRun(capability, nextInput, {
      requestedBy: origin.requestedBy || "workflow-chain",
      origin: origin.origin,
      execution: executionIntentFromInput(parentRun.input || {})
    });
    addRunEvent(parentRun.id, "run.chain.queued", `Queued chained run ${child.id} for ${capability.name}`, {
      childRunId: child.id,
      capability: capability.slug,
      index: index + 1,
      deepLink: deepLinks.run(child.id)
    });
    addRunEvent(child.id, "run.chain.parent", `Created from parent run ${parentRun.id}`, {
      parentRunId: parentRun.id,
      parentCapability: parentRun.capabilitySlug,
      index: index + 1,
      deepLink: deepLinks.run(parentRun.id)
    });
    return child;
  }

  return {
    recordRunEvent(req, res) {
      const message = scrubStoredSecrets(req.body.message || "");
      const data = scrubStoredSecrets(req.body.data || {});
      const event = addRunEvent(req.params.id, req.body.type || "log", message, data);
      if (req.body.type === "workflow.step") updateRun(req.params.id, { current_step: message });
      // An engine-level approval gate decided directly on the runner box: mirror
      // the observed decision onto any still-pending engine_approval card so the
      // card does not linger as a phantom hold after the workflow resumed.
      if (req.body.type === "engine.approval.resumed") resolveEngineApprovalOnResume(req.params.id, data);
      res.json({ event });
    },

    startRun(req, res) {
      const result = transitionRun(req.params.id, "running", { current_step: "running", started_at: now() });
      if (sendTransitionError(res, result)) return;
      ifActiveTransition(result, () => addRunEvent(req.params.id, "run.started", "Run started"));
      res.json({ run: result.run });
    },

    completeRun(req, res) {
      const output = scrubStoredSecrets(req.body.output || {});
      const result = transitionRun(req.params.id, "succeeded", { current_step: "completed", output, completed_at: now() });
      if (sendTransitionError(res, result)) return;
      recordIgnoredTransition(result, req.params.id, "succeeded", addRunEvent);
      const chainedRun = ifActiveTransition(result, () => {
        addRunEvent(req.params.id, "run.succeeded", "Run completed");
        const child = queueNextChainedRun(result.run, output, req);
        recordRunTerminalArtifacts(result.run.id);
        return child;
      });
      res.json({ run: result.run, chainedRun: chainedRun ? withRunLinks(chainedRun) : null });
    },

    failRun(req, res) {
      const error = scrubStoredSecrets(req.body.error || "failed");
      const status = normalizeFailureStatus(req.body.status || classifyFailureStatus(error));
      const result = transitionRun(req.params.id, status, { current_step: status, error, completed_at: now() });
      if (sendTransitionError(res, result)) return;
      recordIgnoredTransition(result, req.params.id, status, addRunEvent);
      ifActiveTransition(result, () => {
        addRunEvent(req.params.id, failureEventType(status), error || `Run ended as ${status}`, { failureClass: status });
        maybeRecordFailureClassAlert(status);
        recordRunTerminalArtifacts(result.run.id);
      });
      res.json({ run: result.run });
    },

    cancelRun(req, res) {
      const result = transitionRun(req.params.id, "cancelled", { current_step: "cancelled", completed_at: now() });
      if (sendTransitionError(res, result)) return;
      ifActiveTransition(result, () => {
        addRunEvent(req.params.id, "run.cancelled", req.body.reason || "Run cancelled");
        recordRunTerminalArtifacts(result.run.id);
      });
      res.json({ run: result.run });
    },

    queueNextChainedRun
  };
}

export function sendTransitionError(res, result) {
  if (result.ok) return false;
  res.status(result.code).json({ error: result.error });
  return true;
}

export function ifActiveTransition(result, fn) {
  if (result.idempotent) return null;
  return fn();
}

function recordIgnoredTransition(result, runId, attempted, addRunEvent) {
  if (!result.raced) return;
  addRunEvent(runId, "run.transition_ignored", `Ignored late '${attempted}' report; run already terminal as '${result.run.status}'`, {
    attempted,
    terminal: result.run.status
  });
}
