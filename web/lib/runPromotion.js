import { api } from "./api.js";
import { refreshCollection } from "./collections.js";
import { toast } from "./toast.js";

const SUCCESS = new Set(["succeeded", "recovered", "approved"]);

function outputNode(run, nodeId) {
  return run?.output?.outputs?.[nodeId] || null;
}

export function runPromotionCandidate(run) {
  const baseline = outputNode(run, "baseline");
  const push = outputNode(run, "push");
  const lease = baseline?.lease || {};
  const sourceBranch = push?.branch || lease.pushBranch || lease.workBranch || "";
  const targetBranch = run?.input?.targetBranch || lease.targetBranch || "main";
  const available = Boolean(
    run?.id
    && SUCCESS.has(run.status)
    && !run?.output?.promotion?.merged
    && (run?.input?.mutationMode || lease.mode) === "parallel"
    && sourceBranch
    && lease.sourceRepoDir
    && (lease.workRepoDir || baseline?.repoDir)
  );
  return { available, sourceBranch, targetBranch };
}

export async function promoteRun(id) {
  try {
    const result = await api(`/api/runs/${encodeURIComponent(id)}/promote`, { method: "POST", body: {} });
    toast("Merged to main", "ok");
    await refreshCollection("runs");
    return result;
  } catch (error) {
    toast(error.message || "Merge failed", "error");
    throw error;
  }
}
