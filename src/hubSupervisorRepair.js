export function buildHubRepairInput(failedRun, decision, options = {}) {
  const requestedRepairBranch = (options.repairBranch && String(options.repairBranch).trim()) || "";
  const repairBranch = requestedRepairBranch && requestedRepairBranch !== "main" ? requestedRepairBranch : "smithers-self-repair";
  const wrappedEntry = String(options.wrappedEntry || "");
  const failedInput =
    failedRun?.input && typeof failedRun.input === "object" && !Array.isArray(failedRun.input) ? failedRun.input : {};
  const capabilitySlug = failedRun?.capabilitySlug || failedRun?.capability_slug || "";
  const fingerprint = decision?.fingerprint || failedRun?.error || "unknown";

  const workPrompt =
    `A supervised run of '${capabilitySlug}' failed with a deterministic workflow-code error.\n` +
    `Error: ${fingerprint}\n` +
    (wrappedEntry ? `Likely source: ${wrappedEntry}\n` : "") +
    "Apply the smallest safe fix to the workflow source so a resume can succeed. Do not change unrelated behavior.";

  const input = {
    workPrompt,
    deploy: false,
    targetBranch: repairBranch,
    commitMessage: `fix: hub-supervisor self-repair of ${wrappedEntry || capabilitySlug}`.slice(0, 200)
  };

  const repoDir = typeof failedInput.repoDir === "string" ? failedInput.repoDir.trim() : "";
  const repo = typeof failedInput.repo === "string" ? failedInput.repo.trim() : "";
  const project = typeof failedInput.project === "string" ? failedInput.project.trim() : "";
  if (repoDir) input.repoDir = repoDir;
  else if (repo) input.repo = repo;
  else if (project) input.project = project;

  const exec = failedInput.__execution;
  if (exec && typeof exec === "object" && !Array.isArray(exec)) input.__execution = exec;

  return input;
}

export function buildEscalationApproval(run, decision) {
  const runId = run?.id || "";
  const capability = run?.capability_slug || run?.capabilitySlug || "";
  const reason = (decision?.reason || "Autonomous recovery exhausted; operator review required.").slice(0, 2000);
  return {
    title: `Needs a decision: ${capability || runId}`.slice(0, 240),
    description: reason,
    // The declared ask. Honest about what resolving does today: the run was
    // already marked failed before this card existed, and no option handlers
    // exist yet, so a decision here is recorded guidance — it does not requeue
    // the run by itself (the escalation-options branch wires that up).
    ask: {
      audience: "operators",
      action:
        "Record how this run should proceed now that autonomous recovery gave up. To try again, re-run it from the run page.",
      reason: reason.slice(0, 500)
    },
    payload: {
      kind: "supervisor_escalation",
      approvalKind: "supervisor_escalation",
      escalation: decision?.escalation || "exhausted",
      runId,
      capability,
      fingerprint: decision?.fingerprint || "",
      attempt: decision?.attempt ?? null,
      options: [
        { id: "retry_anyway", label: "Resume once more", effect: "re-queue the run to resume from its last checkpoint despite the cap" },
        { id: "edit_and_retry", label: "Fix and resume", effect: "operator repairs the workflow / input, then resumes" },
        { id: "abandon", label: "Abandon the run", effect: "stop autonomous recovery and leave the run failed" }
      ]
    }
  };
}
