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
import { normalizePublicWorkflowDefinition } from "./workflowBundlePublishing.js";
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
  publishWorkflowBundle,
  deleteCapability,
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
  const capabilityOr404 = (res, id, noun = "capability") => {
    const capability = getCapability(id);
    if (!capability) {
      res.status(404).json({ error: `${noun} not found` });
      return null;
    }
    return capability;
  };

  const enabledCapabilityOr404 = (res, id, noun = "capability") => {
    const capability = capabilityOr404(res, id, noun);
    if (!capability) return null;
    if (!capability.enabled) {
      res.status(404).json({ error: `${noun} not found` });
      return null;
    }
    return capability;
  };

  const workflowPayload = (capability) => withCapabilityLinks(capability);

  // Normalize public workflow definitions into the production runtime shape:
  // source bytes are published as immutable DB bundles, existing bundle ids are
  // validated, and bare file entries are rejected unless explicitly trusted.
  const normalizeWorkflowForPublish = (req, res, definition) => {
    let normalized;
    try {
      const base = normalizeCapabilityDefinition(definition);
      normalized = normalizePublicWorkflowDefinition({
        definition: {
          ...base,
          workflow: { ...base.workflow, ...(definition.workflow || {}) },
          workflowSource: definition.workflowSource,
          sourceBytes: definition.sourceBytes,
          code: definition.code,
          workflowLanguage: definition.workflowLanguage
        },
        getWorkflowBundle,
        publishWorkflowBundle,
        createdBy: requestOrigin(req, definition).requestedBy || req.token?.name || ""
      });
    } catch (cause) {
      if (cause.code === "workflow_bundle_missing") {
        res.status(400).json({
          error: `workflow bundle ${cause.bundleId} not found; provide workflow source bytes or publish the bundle via POST /api/workflow-bundles before referencing it`,
          bundleId: cause.bundleId
        });
        return null;
      }
      if (cause.code === "workflow_source_required") {
        res.status(400).json({
          error: cause.message,
          code: cause.code
        });
        return null;
      }
      if (cause.code === "workflow_bundle_too_large") {
        res.status(413).json({
          error: cause.message,
          sizeBytes: cause.sizeBytes,
          maxWorkflowBundleBytes: cause.maxWorkflowBundleBytes
        });
        return null;
      }
      throw cause;
    }
    let source;
    try {
      source = loadWorkflowSource(normalized, { root, getWorkflowBundle });
    } catch (cause) {
      if (cause.code !== "workflow_bundle_missing") throw cause;
      res.status(400).json({
        error: `workflow bundle ${cause.bundleId} not found; provide workflow source bytes or publish the bundle via POST /api/workflow-bundles before referencing it`,
        bundleId: cause.bundleId
      });
      return null;
    }
    const error = workflowBundleSizeError(source);
    if (!error) return normalized;
    res.status(413).json({
      error,
      sizeBytes: source.sizeBytes,
      maxWorkflowBundleBytes: MAX_WORKFLOW_BUNDLE_BYTES,
      path: source.relativePath
    });
    return null;
  };

  const handlers = {
    listWorkflows(req, res) {
      const includeDisabled = req.query.all === "1" && (req.token.scopes || []).includes("admin");
      res.json({ workflows: listCapabilities({ q: req.query.q || "", includeDisabled }).map(workflowPayload) });
    },

    createWorkflow(req, res) {
      const body = { ...req.body, slug: requireBodySlug(req.body, "workflow") };
      const normalized = normalizeWorkflowForPublish(req, res, body);
      if (!normalized) return;
      res.json({ workflow: upsertCapability(normalized) });
    },

    getWorkflow(req, res) {
      const capability = capabilityOr404(res, req.params.id, "workflow");
      if (!capability) return;
      res.json({ workflow: workflowPayload(capability) });
    },

    getWorkflowVersions(req, res) {
      const capability = capabilityOr404(res, req.params.name, "workflow");
      if (!capability) return;
      res.json({
        workflow: { slug: capability.slug, name: capability.name },
        versioningEnabled: capabilityVersioningEnabled(env),
        versions: listCapabilityVersionsFromRuns(capability.slug)
      });
    },

    getWorkflowSource(req, res) {
      const capability = capabilityOr404(res, req.params.id, "workflow");
      if (!capability) return;
      return sendCapabilitySource({ req, res, capability, asWorkflow: true });
    },

    updateWorkflow(req, res) {
      const existing = capabilityOr404(res, req.params.id, "workflow");
      if (!existing) return;
      const merged = { ...existing, ...req.body, slug: existing.slug };
      const normalized = normalizeWorkflowForPublish(req, res, merged);
      if (!normalized) return;
      res.json({ workflow: upsertCapability(normalized) });
    },

    deleteWorkflow(req, res) {
      if (!deleteCapability) return res.status(501).json({ error: "workflow deletion is not available on this Hub" });
      const deleted = deleteCapability(req.params.id);
      if (!deleted) return res.status(404).json({ error: "workflow not found" });
      res.json({ workflow: workflowPayload(deleted), deleted: true });
    },

    async runWorkflow(req, res) {
      return runCapabilityRequest(req, res, "workflow");
    },

    preflightWorkflow(req, res) {
      return preflightCapabilityRequest(req, res, "workflow");
    },

    listCapabilities(req, res) {
      const includeDisabled = req.query.all === "1" && (req.token.scopes || []).includes("admin");
      res.json({ capabilities: listCapabilities({ q: req.query.q || "", includeDisabled }).map(withCapabilityLinks) });
    },

    createCapability(req, res) {
      const body = { ...req.body, slug: requireBodySlug(req.body, "capability") };
      const normalized = normalizeWorkflowForPublish(req, res, body);
      if (!normalized) return;
      res.json({ capability: upsertCapability(normalized) });
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
      return sendCapabilitySource({ req, res, capability });
    },

    updateCapability(req, res) {
      const existing = capabilityOr404(res, req.params.id);
      if (!existing) return;
      const merged = { ...existing, ...req.body, slug: existing.slug };
      const normalized = normalizeWorkflowForPublish(req, res, merged);
      if (!normalized) return;
      res.json({ capability: upsertCapability(normalized) });
    },

    async runCapability(req, res) {
      return runCapabilityRequest(req, res, "capability");
    },

    // Stateless negotiation report: same deterministic checks as negotiate
    // mode and draft submission, but nothing is stored and nothing is
    // enqueued. Safe to call repeatedly while composing a request.
    preflightCapability(req, res) {
      return preflightCapabilityRequest(req, res, "capability");
    }
  };

  return handlers;

  function sendCapabilitySource({ res, capability, asWorkflow = false }) {
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
      const payload = {
        slug: capability.slug,
        available: false,
        message: "No workflow source file shipped for this workflow. The graph below is derived from registered metadata only.",
        graph: deriveWorkflowGraphFromMetadata(capability)
      };
      payload[asWorkflow ? "workflow" : "capability"] = withCapabilityLinks(capability);
      return res.json(payload);
    }
    const payload = capabilitySourcePayload({ capability, source, withCapabilityLinks });
    if (asWorkflow) {
      payload.workflow = payload.capability;
      delete payload.capability;
    }
    return res.json(payload);
  }

  async function runCapabilityRequest(req, res, noun) {
    const capability = enabledCapabilityOr404(res, req.params.id, noun);
    if (!capability) return;
    if (capability.workflow?.adminOnly && !(req.token?.scopes || []).includes("admin")) {
      return res.status(403).json({ error: "admin scope required", [noun]: capability.slug });
    }

    const responseEndpointResult = parseResponseEndpoint(req.body.responseEndpoint);
    if (!responseEndpointResult.ok) return res.status(400).json({ error: responseEndpointResult.error });

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
          message: `Requested post-run hook profiles are not enabled/allowed for this ${noun}. An admin manages hook profiles via /api/hooks.`
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
  }

  function preflightCapabilityRequest(req, res, noun) {
    const capability = enabledCapabilityOr404(res, req.params.id, noun);
    if (!capability) return;
    if (capability.workflow?.adminOnly && !(req.token?.scopes || []).includes("admin")) {
      return res.status(403).json({ error: "admin scope required", [noun]: capability.slug });
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
