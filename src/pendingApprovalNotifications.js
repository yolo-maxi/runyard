export function pendingApprovalForRun(runId, { listApprovals = () => [] } = {}) {
  if (!runId) return null;
  return listApprovals("pending").find((approval) => approval.runId === runId) || null;
}

export async function notifyPendingApprovalForRun(runId, {
  listApprovals = () => [],
  notifyTelegram = async () => {}
} = {}) {
  const approval = pendingApprovalForRun(runId, { listApprovals });
  if (!approval) return null;
  await notifyTelegram(approval);
  return approval;
}
