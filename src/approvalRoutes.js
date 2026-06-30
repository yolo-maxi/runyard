export function childApprovalKey(payload = {}) {
  const childRunId = String(payload.childRunId || payload.child?.runId || "").trim();
  const nodeId = String(payload.nodeId || payload.approvalNode || payload.child?.nodeId || "").trim();
  return childRunId && nodeId ? { childRunId, nodeId } : null;
}

export function findExistingChildRunApproval(approvals = [], payload = {}) {
  const expected = childApprovalKey(payload);
  if (!expected) return null;
  return approvals.find((approval) => {
    const actual = childApprovalKey(approval.payload || {});
    return actual?.childRunId === expected.childRunId && actual?.nodeId === expected.nodeId;
  }) || null;
}

export function requestedApprovalRunId(body = {}, payload = {}) {
  return body.runId || payload.childRunId || null;
}

export function linkedApprovalRunId(body = {}, payload = {}, { getRun } = {}) {
  const requested = requestedApprovalRunId(body, payload);
  return requested && getRun?.(requested) ? requested : null;
}

export function approvalCreateInput(body = {}, token = {}, { getRun } = {}) {
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  return {
    runId: linkedApprovalRunId(body, payload, { getRun }),
    title: String(body.title || "Approval requested").slice(0, 240),
    description: String(body.description || "").slice(0, 2000),
    requestedBy: String(body.requestedBy || token.name || "workflow").slice(0, 120),
    payload
  };
}

export function defaultApprovalComment(decision, surface = "Web/API") {
  if (decision === "approved") return `Approved from ${surface}`;
  if (decision === "changes_requested") return `Changes requested from ${surface}`;
  return `Rejected from ${surface}`;
}

export function decisionTriggersTerminalDelivery(decision) {
  return decision === "rejected" || decision === "changes_requested";
}
