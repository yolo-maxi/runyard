import {
  capabilityVersioningEnabled,
  resolveCapabilityVersionOptions
} from "./runExecution.js";
import {
  parseResponseEndpoint
} from "./runResponseEndpoint.js";
import { notifyPendingApprovalForRun } from "./pendingApprovalNotifications.js";
import {
  deriveWorkflowGraph,
  deriveWorkflowGraphFromMetadata,
  loadWorkflowSource,
  MAX_WORKFLOW_BUNDLE_BYTES,
  parseWorkflowMetadata,
  sliceWorkflowSections,
  workflowBundleSizeError
} from "./workflowSource.js";
import { normalizeCapabilityDefinition } from "./capabilityRecords.js";
import { eligibleHookProfiles } from "./hookProfileRecords.js";
import { requestOrigin, requireBodySlug } from "./requestContext.js";
import {
  capabilityRunInput,
  capabilityRunResponse,
  prepareCapabilityRunRequest,
  registerRunResponseEndpoint
} from "./capabilityRun.js";
import { draftOptionsFromBody, negotiationStatusCode, presentRunDraft } from "./runDraftRoutes.js";
import { RUN_PREFLIGHT_READY } from "./runPreflight.js";

export {
  capabilityRunDispatchOptions,
  capabilityRunInput
} from "./capabilityRun.js";

export function createCapabilityHandlers({
  addRunEvent,
  createRunDraft = null,
  createRunResponseEndpoint,
  dispatchRun,
  evaluatePreflight = null,
  getCapability,
  getWorkflowBundle,
  listApprovals,
  listCapabilities,
  listCapabilityVersionsFromRuns,
  listHookProfiles = () => [],
  notifyTelegram,
  recordAudit,
  root,
  upsertCapability,
  withCapabilityLinks,
  withRunLinks,
  env = process.env
} = {}) {
  const capabilityOr404 = (res, id) => {
    const capability = getCapability(id);
    if (!capability) {
      res.status(404).json({ error: "capability not found" });
      return null;
    }
    return capability;
  };

  const enabledCapabilityOr404 = (res, id) => {
    const capability = capabilityOr404(res, id);
    if (!capability) return null;
    if (!capability.enabled) {
      res.status(404).json({ error: "capability not found" });
      return null;
    }
    return capability;
  };

  // Reject definitions whose workflow bundle can't be published: a DB bundle
  // reference that doesn't exist (400 — publish the bundle first) or a bundle
  // that exceeds the publish-time cap (413) — before anything is stored, so
  // broken or oversized bundles never reach dispatch.
  const workflowBundlePublishBlocked = (res, definition) => {
    const normalized = normalizeCapabilityDefinition(definition);
    let source;
    try {
      source = loadWorkflowSource(normalized, { root, getWorkflowBundle });
    } catch (cause) {
      if (cause.code !== "workflow_bundle_missing") throw cause;
      res.status(400).json({
        error: `workflow bundle ${cause.bundleId} not found; publish the bundle via POST /api/workflow-bundles before referencing it`,
        bundleId: cause.bundleId
      });
      return true;
    }
    const error = workflowBundleSizeError(source);
    if (!error) return false;
    res.status(413).json({
      error,
      sizeBytes: source.sizeBytes,
      maxWorkflowBundleBytes: MAX_WORKFLOW_BUNDLE_BYTES,
      path: source.relativePath
    });
    return true;
  };

  return {
    listCapabilities(req, res) {
      const includeDisabled = req.query.all === "1" && (req.token.scopes || []).includes("admin");
      res.json({ capabilities: listCapabilities({ q: req.query.q || "", includeDisabled }).map(withCapabilityLinks) });
    },

    createCapability(req, res) {
      const body = { ...req.body, slug: requireBodySlug(req.body, "capability") };
      if (workflowBundlePublishBlocked(res, body)) return;
      res.json({ capability: upsertCapability(body) });
    },

    getCapability(req, res) {
      const capability = capabilityOr404(res, req.params.id);
      if (!capability) return;
      res.json({ capability: withCapabilityLinks(capability) });
    },

    getCapabilityVersions(req, res) {
      const capability = capabilityOr404(res, req.params.name);
      if (!capability) return;
      res.json({
        capability: { slug: capability.slug, name: capability.name },
        versioningEnabled: capabilityVersioningEnabled(env),
        versions: listCapabilityVersionsFromRuns(capability.slug)
      });
    },

    getCapabilitySource(req, res) {
      const capability = capabilityOr404(res, req.params.id);
      if (!capability) return;
      let source;
      try {
        source = loadWorkflowSource(capability, { root, getWorkflowBundle });
      } catch (error) {
        // A configured DB bundle that is missing is a hard, explicit failure —
        // never a silent fall-through to the metadata-only graph or a file.
        if (error.code !== "workflow_bundle_missing") throw error;
        return res.status(409).json({
          slug: capability.slug,
          available: false,
          bundleId: error.bundleId,
          error: error.message
        });
      }
      if (!source) {
        return res.json({
          slug: capability.slug,
          available: false,
          capability: withCapabilityLinks(capability),
          message: "No workflow source file shipped for this capability. The graph below is derived from registered metadata only.",
          graph: deriveWorkflowGraphFromMetadata(capability)
        });
      }
      res.json(capabilitySourcePayload({ capability, source, withCapabilityLinks }));
    },

    updateCapability(req, res) {
      const existing = capabilityOr404(res, req.params.id);
      if (!existing) return;
      const merged = { ...existing, ...req.body, slug: existing.slug };
      if (workflowBundlePublishBlocked(res, merged)) return;
      res.json({ capability: upsertCapability(merged) });
    },

    async runCapability(req, res) {
      const capability = enabledCapabilityOr404(res, req.params.id);
      if (!capability) return;
      if (capability.workflow?.adminOnly && !(req.token?.scopes || []).includes("admin")) {
        return res.status(403).json({ error: "admin scope required", capability: capability.slug });
      }

      const responseEndpointResult = parseResponseEndpoint(req.body.responseEndpoint);
      if (!responseEndpointResult.ok) return res.status(400).json({ error: responseEndpointResult.error });

      // Negotiation mode (opt-in via body.negotiate): run the deterministic
      // preflight first. A non-ready request never becomes a run — it comes
      // back as a structured negotiation state plus an editable draft the
      // caller can PATCH and submit. Without the flag, create semantics are
      // unchanged for existing clients.
      let negotiation = null;
      if (req.body?.negotiate === true && evaluatePreflight) {
        const draftOptions = draftOptionsFromBody(req.body || {});
        negotiation = evaluatePreflight({
          capability,
          input: capabilityRunInput(req.body || {}),
          options: draftOptions
        });
        if (negotiation.status !== RUN_PREFLIGHT_READY) {
          const draft = createRunDraft
            ? createRunDraft({
              capabilitySlug: capability.slug,
              input: negotiation.input,
              options: draftOptions,
              status: negotiation.status,
              preflight: negotiation,
              createdBy: requestOrigin(req, negotiation.input).requestedBy
            })
            : null;
          return res.status(negotiationStatusCode(negotiation.status)).json({
            error: `preflight is ${negotiation.status}; no run was created`,
            negotiation,
            ...(draft ? { draft: presentRunDraft(draft) } : {})
          });
        }
      }

      // Post-run hooks are opt-in twice over: the capability must permit the
      // profile (workflow.hooks.allowedProfiles) AND the admin-authored
      // profile must be enabled and allow the capability. Reject ineligible
      // selections at dispatch so a run never starts with a hook it is not
      // allowed to invoke.
      const requestedHooks = Array.isArray(req.body?.input?.postRunHooks)
        ? req.body.input.postRunHooks.map((slug) => String(slug || "").trim()).filter(Boolean)
        : [];
      if (requestedHooks.length) {
        const eligible = eligibleHookProfiles({ capability, profiles: listHookProfiles({ includeDisabled: false }) });
        const eligibleSlugs = new Set(eligible.map((profile) => profile.slug));
        const blocked = requestedHooks.filter((slug) => !eligibleSlugs.has(slug));
        if (blocked.length) {
          return res.status(400).json({
            error: "hook_blocked",
            blocked,
            eligible: [...eligibleSlugs],
            message: "Requested post-run hook profiles are not enabled/allowed for this capability. An admin manages hook profiles via /api/hooks."
          });
        }
      }

      const { dispatchOptions, input, origin } = prepareCapabilityRunRequest({ req, capability, env });
      const dispatched = dispatchRun(capability, input, dispatchOptions);
      const run = dispatched.run;
      const registeredResponseEndpoint = registerRunResponseEndpoint({
        addRunEvent,
        createRunResponseEndpoint,
        origin,
        recordAudit,
        responseEndpoint: responseEndpointResult.value,
        run,
        token: req.token
      });
      await notifyPendingApprovalForRun(run.id, { listApprovals, notifyTelegram });
      res.status(202).json({
        ...capabilityRunResponse({
          dispatched,
          registeredResponseEndpoint,
          run,
          withRunLinks
        }),
        ...(negotiation ? { negotiation } : {})
      });
    },

    // Stateless negotiation report: same deterministic checks as negotiate
    // mode and draft submission, but nothing is stored and nothing is
    // enqueued. Safe to call repeatedly while composing a request.
    preflightCapability(req, res) {
      const capability = enabledCapabilityOr404(res, req.params.id);
      if (!capability) return;
      if (capability.workflow?.adminOnly && !(req.token?.scopes || []).includes("admin")) {
        return res.status(403).json({ error: "admin scope required", capability: capability.slug });
      }
      if (!evaluatePreflight) {
        return res.status(503).json({ error: "preflight is not available on this Hub" });
      }
      const negotiation = evaluatePreflight({
        capability,
        input: capabilityRunInput(req.body || {}),
        options: draftOptionsFromBody(req.body || {})
      });
      res.json({ negotiation });
    }
  };
}

function capabilitySourcePayload({ capability, source, withCapabilityLinks }) {
  const metadata = parseWorkflowMetadata(source.code);
  const sections = sliceWorkflowSections(source.code);
  const graph = deriveWorkflowGraph(source.code, capability);
  return {
    slug: capability.slug,
    available: true,
    capability: withCapabilityLinks(capability),
    path: source.relativePath,
    language: source.language,
    sizeBytes: source.sizeBytes,
    ...(source.bundleId
      ? { bundleId: source.bundleId, bundleVersion: source.bundleVersion, sha256: source.sha256 }
      : {}),
    metadata,
    sections,
    code: source.code,
    graph
  };
}
