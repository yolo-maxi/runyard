import { notifyPendingApprovalForRun } from "./pendingApprovalNotifications.js";
import { requestOrigin } from "./requestContext.js";
import { runStatusLinks } from "./runHttpPresentation.js";
import {
  cleanRerunInput,
  findActiveDuplicateRerun
} from "./runRerun.js";

export function createRunRerunHandlers({
  addRunEvent,
  dispatchRun,
  getCapability,
  getRun,
  listApprovals,
  listRuns,
  notifyTelegram,
  withRunLinks
} = {}) {
  function findDuplicate({ previousRunId, capabilitySlug, input }) {
    return findActiveDuplicateRerun(listRuns({ limit: 500, includeInternal: true }), {
      previousRunId,
      capabilitySlug,
      input
    });
  }

  return {
    async rerunRun(req, res) {
      const previous = getRun(req.params.id);
      if (!previous) return res.status(404).json({ error: "run not found" });

      const previousPresented = withRunLinks(previous);
      const capability = getCapability(previousPresented.capabilitySlug);
      if (!capability || !capability.enabled) return res.status(404).json({ error: "capability not found" });

      const editedInput = req.body?.input && typeof req.body.input === "object" && !Array.isArray(req.body.input)
        ? req.body.input
        : null;
      const input = cleanRerunInput(editedInput || previousPresented.input, previous.id);
      if (req.body?.force !== true) {
        const existing = findDuplicate({ previousRunId: previous.id, capabilitySlug: capability.slug, input });
        if (existing) {
          addRunEvent(previous.id, "run.rerun_deduped", `Duplicate re-run reused ${existing.id}`, { runId: existing.id });
          return res.status(202).json(rerunAcceptedResponse({
            deduped: true,
            previous,
            run: existing,
            withRunLinks
          }));
        }
      }

      const origin = requestOrigin(req, {
        ...input,
        origin: {
          label: `Re-run from Hub of ${previous.id}`,
          type: "hub-rerun",
          previousRunId: previous.id
        }
      });
      const dispatched = dispatchRun(capability, input, {
        requestedBy: origin.requestedBy,
        origin: origin.origin,
        // A re-run inherits the previous run's spend budget unless the edited
        // input carries its own (body.budget > input.budget > previous budget).
        ...(req.body?.budget !== undefined
          ? { budget: req.body.budget }
          : previous.budget && input.budget === undefined
            ? { budget: previous.budget }
            : {})
      });
      const run = dispatched.run;
      addRunEvent(previous.id, "run.rerun_requested", `Re-run requested as ${run.id}`, { runId: run.id });
      addRunEvent(run.id, "run.rerun_of", `Re-run of ${previous.id}`, { previousRunId: previous.id });

      await notifyPendingApprovalForRun(run.id, { listApprovals, notifyTelegram });

      res.status(202).json(rerunAcceptedResponse({
        dispatched,
        previous,
        run,
        withRunLinks
      }));
    }
  };
}

export function rerunAcceptedResponse({ deduped = false, dispatched = {}, previous, run, withRunLinks }) {
  return {
    ...(deduped ? { deduped: true } : {}),
    run: withRunLinks(run),
    previousRun: withRunLinks(previous),
    ...runStatusLinks(run.id)
  };
}
