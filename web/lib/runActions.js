import { api } from "./api.js";
import { navigate, deepLinks } from "./router.js";
import { toast } from "./toast.js";
import { refreshCollection } from "./collections.js";

export const RERUN_DRAFT_KEY = "runyard.editRerunDraft.v1";

export function peekRerunDraft() {
  try {
    const raw = sessionStorage.getItem(RERUN_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!draft?.capabilitySlug) return null;
    return draft;
  } catch {
    try { sessionStorage.removeItem(RERUN_DRAFT_KEY); } catch {}
    return null;
  }
}

export function clearRerunDraft() {
  try { sessionStorage.removeItem(RERUN_DRAFT_KEY); } catch {}
}

// Re-run a run with identical input, then open the new run. Ported from
// rerunRun(); refreshes the runs collection so the list reflects it.
export async function rerunRun(id) {
  const result = await api(`/api/runs/${id}/rerun`, { method: "POST", body: {} });
  toast("Re-run queued", "ok");
  await refreshCollection("runs");
  navigate(deepLinks.run(result.run.id));
  return result.run;
}

// Stash an editable draft of a run's input and jump to the workflow run form.
// Ported from editRerunRun().
export function editRerunRun(run) {
  if (!run?.id || !run.capabilitySlug) {
    toast("Cannot edit this run", "error");
    return;
  }
  const input = run.input && typeof run.input === "object" && !Array.isArray(run.input) ? { ...run.input } : {};
  delete input.__origin;
  delete input.rerunOf;
  try {
    sessionStorage.setItem(
      RERUN_DRAFT_KEY,
      JSON.stringify({
        previousRunId: run.id,
        capabilitySlug: run.capabilitySlug,
        input,
        at: new Date().toISOString()
      })
    );
  } catch {
    /* storage disabled — proceed without the draft */
  }
  navigate(deepLinks.workflowRun(run.capabilitySlug));
}

// Fetch a run (for its full input) then open the edit-rerun form.
export async function editRerunById(id) {
  const data = await api(`/api/runs/${encodeURIComponent(id)}`);
  editRerunRun(data.run);
}

// Resume a paused run: it re-queues and continues from its recorded engine
// checkpoint when one exists (the server response says which strategy ran).
export async function resumeRun(id) {
  const result = await api(`/api/runs/${id}/resume`, { method: "POST", body: {} });
  toast(result.resume?.strategy === "rerun_from_scratch"
    ? "Run re-queued — no checkpoint was recorded, so it restarts from scratch"
    : "Run resumed from its checkpoint", "ok");
  await refreshCollection("runs");
  return result.run;
}

export async function cancelRun(id, reason) {
  const result = await api(`/api/runs/${id}/cancel`, { method: "POST", body: reason ? { reason } : {} });
  toast("Run cancelled", "ok");
  await refreshCollection("runs");
  return result.run;
}
