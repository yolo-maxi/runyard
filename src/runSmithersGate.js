// Hard gate the supervising wrapper run on a real `succeeded` outcome. This
// makes a failed wrapper visibly fail at the workflow layer instead of relying
// on Hub-side outcome-string fallback after the lineage has already persisted.
export function assertSupervisionSucceeded(result) {
  const safe = result && typeof result === "object" ? result : {};
  const outcome = String(safe.outcome || "");
  if (outcome === "succeeded") return safe;
  const capability = String(safe.capability || safe.wrappedCapability || "");
  const lineageCount = Array.isArray(safe.lineage) ? safe.lineage.length : 0;
  const repairCount = Array.isArray(safe.repairs) ? safe.repairs.length : 0;
  const codeRepairs = Number.isFinite(safe.codeRepairs) ? safe.codeRepairs : 0;
  const approvalRequested = Boolean(safe.approval) || Boolean(safe.approvalRequested);
  const summary = String(safe.summary || "").slice(0, 600);
  const labelled = capability ? ` of '${capability}'` : "";
  const parts = [
    `run-smithers supervision${labelled} did not reach a 'succeeded' outcome (got '${outcome || "unknown"}').`,
    `attempts=${lineageCount} repairs=${repairCount} codeRepairs=${codeRepairs} approvalRequested=${approvalRequested}.`
  ];
  if (summary) parts.push(`summary: ${summary}`);
  parts.push(
    "Wrapped child runs failed and autonomous recovery (retries + one-shot workflow-code repair) did not finish the goal."
  );
  throw new Error(parts.join(" "));
}
