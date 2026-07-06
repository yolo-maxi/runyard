// Run drafts: the stateful half of run-creation negotiation.
//
// A draft is a proposed run that has NOT been enqueued. Its status always
// mirrors the latest deterministic preflight (ready / needs_input / blocked)
// until it leaves negotiation as submitted (a real run was enqueued) or
// discarded. Invalid or underspecified requests therefore live here as
// editable drafts instead of becoming failed runs.
//
//   POST  /api/run-drafts              create + preflight
//   GET   /api/run-drafts              list (filter: status, capability)
//   GET   /api/run-drafts/:id          inspect
//   PATCH /api/run-drafts/:id          answer questions / edit input, re-preflight
//   POST  /api/run-drafts/:id/submit   enqueue the real run — only when ready
//   POST  /api/run-drafts/:id/discard  abandon the negotiation

import { notifyPendingApprovalForRun } from "./pendingApprovalNotifications.js";
import { runOutputLinks } from "./runHttpPresentation.js";
import { mergeRunDraftInput, RUN_DRAFT_SUBMITTED, runDraftIsOpen } from "./runDraftRecords.js";
import { RUN_PREFLIGHT_BLOCKED, RUN_PREFLIGHT_READY } from "./runPreflight.js";
import { requestOrigin } from "./requestContext.js";

export function presentRunDraft(draft) {
  if (!draft) return null;
  return {
    id: draft.id,
    capability: draft.capabilitySlug,
    status: draft.status,
    input: draft.input,
    options: draft.options,
    preflight: draft.preflight,
    createdBy: draft.createdBy,
    runId: draft.runId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    nextAction: draft.status === RUN_DRAFT_SUBMITTED
      ? `Draft was submitted; follow the run at /api/runs/${draft.runId}.`
      : draft.preflight?.nextAction || ""
  };
}

// Negotiation states map to distinct HTTP codes so clients can branch without
// parsing: 422 = the caller can fix it with more input, 409 = an operator/
// config blocker (or a draft that already left negotiation).
export function negotiationStatusCode(status) {
  return status === RUN_PREFLIGHT_BLOCKED ? 409 : 422;
}

export function draftOptionsFromBody(body = {}) {
  const options = {};
  const executionMode = body.executionMode ?? body.where;
  if (executionMode !== undefined && executionMode !== null && String(executionMode).trim() !== "") {
    options.executionMode = String(executionMode).trim();
  }
  if (body.runnerLocation !== undefined && body.runnerLocation !== null && String(body.runnerLocation).trim() !== "") {
    options.runnerLocation = String(body.runnerLocation).trim();
  }
  return options;
}

export function createRunDraftHandlers({
  createRunDraft,
  discardRunDraft,
  dispatchRun,
  evaluatePreflight,
  getCapability,
  getRunDraft,
  listApprovals,
  listRunDrafts,
  markRunDraftSubmitted,
  notifyTelegram,
  recordAudit,
  updateRunDraft,
  withRunLinks
}) {
  // Draft visibility mirrors the run route: disabled capabilities 404 for
  // non-admins, and adminOnly workflows are admin-scoped at both create and
  // submit so a draft can never smuggle a run past that gate.
  const capabilityAccess = (req, res, slug) => {
    const capability = getCapability(slug);
    const isAdmin = (req.token?.scopes || []).includes("admin");
    if (!capability || (!capability.enabled && !isAdmin)) {
      res.status(404).json({ error: "capability not found" });
      return null;
    }
    if (capability.workflow?.adminOnly && !isAdmin) {
      res.status(403).json({ error: "admin scope required", capability: capability.slug });
      return null;
    }
    return capability;
  };

  const draftOr404 = (res, draftId) => {
    const draft = getRunDraft(draftId);
    if (!draft) {
      res.status(404).json({ error: "run draft not found" });
      return null;
    }
    return draft;
  };

  const openDraftOr409 = (res, draft) => {
    if (runDraftIsOpen(draft)) return true;
    res.status(409).json({
      error: `run draft is ${draft.status}, not open for negotiation`,
      draft: presentRunDraft(draft)
    });
    return false;
  };

  return {
    listRunDrafts(req, res) {
      const drafts = listRunDrafts({
        status: String(req.query.status || ""),
        capability: String(req.query.capability || "")
      });
      res.json({ drafts: drafts.map(presentRunDraft) });
    },

    createRunDraft(req, res) {
      const body = req.body || {};
      const slug = String(body.capability || body.capabilitySlug || body.id || "").trim();
      if (!slug) {
        return res.status(400).json({ error: "capability is required" });
      }
      const capability = capabilityAccess(req, res, slug);
      if (!capability) return;
      const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {};
      const options = draftOptionsFromBody(body);
      const preflight = evaluatePreflight({ capability, input, options });
      const origin = requestOrigin(req, input);
      const draft = createRunDraft({
        capabilitySlug: capability.slug,
        input,
        options,
        status: preflight.status,
        preflight,
        createdBy: origin.requestedBy
      });
      recordAudit(origin.requestedBy, "run_draft.created", draft.id, {
        capability: capability.slug,
        status: draft.status
      });
      res.status(201).json({ draft: presentRunDraft(draft) });
    },

    getRunDraft(req, res) {
      const draft = draftOr404(res, req.params.id);
      if (!draft) return;
      res.json({ draft: presentRunDraft(draft) });
    },

    patchRunDraft(req, res) {
      const draft = draftOr404(res, req.params.id);
      if (!draft) return;
      if (!openDraftOr409(res, draft)) return;
      const capability = capabilityAccess(req, res, draft.capabilitySlug);
      if (!capability) return;
      const body = req.body || {};
      const patch = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {};
      const input = body.replaceInput === true ? { ...patch } : mergeRunDraftInput(draft.input, patch);
      const options = { ...draft.options, ...draftOptionsFromBody(body) };
      const preflight = evaluatePreflight({ capability, input, options });
      const updated = updateRunDraft(draft.id, {
        input: preflight.input,
        options,
        status: preflight.status,
        preflight
      });
      res.json({ draft: presentRunDraft(updated) });
    },

    async submitRunDraft(req, res) {
      const draft = draftOr404(res, req.params.id);
      if (!draft) return;
      if (!openDraftOr409(res, draft)) return;
      const capability = capabilityAccess(req, res, draft.capabilitySlug);
      if (!capability) return;

      // Re-preflight at submit time: runners, secrets, hooks, or the
      // capability itself may have changed since the draft was last touched.
      const preflight = evaluatePreflight({ capability, input: draft.input, options: draft.options });
      if (preflight.status !== RUN_PREFLIGHT_READY) {
        const updated = updateRunDraft(draft.id, { status: preflight.status, preflight });
        return res.status(negotiationStatusCode(preflight.status)).json({
          error: `run draft is not ready: preflight is ${preflight.status}`,
          draft: presentRunDraft(updated),
          negotiation: preflight
        });
      }

      const origin = requestOrigin(req, preflight.input);
      const dispatched = dispatchRun(capability, preflight.input, {
        requestedBy: origin.requestedBy,
        origin: { ...origin.origin, draftId: draft.id },
        execution: preflight.execution
      });
      const run = dispatched.run;
      const updated = markRunDraftSubmitted(draft.id, { runId: run.id, preflight });
      recordAudit(origin.requestedBy, "run_draft.submitted", draft.id, {
        capability: capability.slug,
        runId: run.id
      });
      await notifyPendingApprovalForRun(run.id, { listApprovals, notifyTelegram });
      res.status(202).json({
        draft: presentRunDraft(updated),
        run: withRunLinks(run),
        negotiation: preflight,
        ...runOutputLinks(run.id)
      });
    },

    discardRunDraft(req, res) {
      const draft = draftOr404(res, req.params.id);
      if (!draft) return;
      if (!openDraftOr409(res, draft)) return;
      const updated = discardRunDraft(draft.id);
      recordAudit(requestOrigin(req).requestedBy, "run_draft.discarded", draft.id, {
        capability: draft.capabilitySlug
      });
      res.json({ draft: presentRunDraft(updated) });
    }
  };
}
