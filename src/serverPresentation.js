import {
  approvalContext as buildApprovalContext,
  withApprovalLinks as decorateApprovalLinks
} from "./approvalPresentation.js";
import {
  buildQueueIndex,
  deriveRunDescription,
  deriveRunTitle,
  withRunLinks as decorateRunLinks
} from "./runPresentation.js";
import { runDiagnostics as buildRunDiagnostics } from "./runDiagnostics.js";

export function createServerPresentation({
  getCapability,
  getRun,
  listApprovals,
  listRuns,
  sanitizeForDisplay,
  withArtifactLinks
} = {}) {
  const runPresentationDeps = {
    getCapability,
    getRun
  };
  const runDiagnosticsDeps = {
    listApprovals,
    sanitizeForDisplay,
    withArtifactLinks
  };
  const approvalPresentationDeps = {
    getRun,
    getCapability,
    deriveRunTitle,
    deriveRunDescription
  };

  function runDiagnostics(run, events = [], artifacts = []) {
    return buildRunDiagnostics(run, events, artifacts, runDiagnosticsDeps);
  }

  function withRunLinks(run, queueIndex = null) {
    return decorateRunLinks(run, queueIndex, runPresentationDeps);
  }

  function decorateSingleRun(run) {
    if (!run) return run;
    if (run.status !== "queued") return withRunLinks(run);
    const queueIndex = buildQueueIndex(listRuns({ status: "queued", limit: 500 }));
    return withRunLinks(run, queueIndex);
  }

  function approvalContext(approval) {
    return buildApprovalContext(approval, approvalPresentationDeps);
  }

  function withApprovalLinks(approval) {
    return decorateApprovalLinks(approval, approvalPresentationDeps);
  }

  return {
    approvalContext,
    decorateSingleRun,
    runDiagnostics,
    withApprovalLinks,
    withRunLinks
  };
}
