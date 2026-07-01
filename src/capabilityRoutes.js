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
  parseWorkflowMetadata,
  sliceWorkflowSections
} from "./workflowSource.js";
import { requireBodySlug } from "./requestContext.js";
import {
  capabilityRunResponse,
  prepareCapabilityRunRequest,
  registerRunResponseEndpoint
} from "./capabilityRun.js";

export {
  capabilityRunDispatchOptions,
  capabilityRunInput
} from "./capabilityRun.js";

export function createCapabilityHandlers({
  addRunEvent,
  createRunResponseEndpoint,
  dispatchRun,
  getCapability,
  listApprovals,
  listCapabilities,
  listCapabilityVersionsFromRuns,
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

  return {
    listCapabilities(req, res) {
      const includeDisabled = req.query.all === "1" && (req.token.scopes || []).includes("admin");
      res.json({ capabilities: listCapabilities({ q: req.query.q || "", includeDisabled }).map(withCapabilityLinks) });
    },

    createCapability(req, res) {
      const body = { ...req.body, slug: requireBodySlug(req.body, "capability") };
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
      const source = loadWorkflowSource(capability, { root });
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
      res.json({ capability: upsertCapability({ ...existing, ...req.body, slug: existing.slug }) });
    },

    async runCapability(req, res) {
      const capability = enabledCapabilityOr404(res, req.params.id);
      if (!capability) return;
      if (capability.workflow?.adminOnly && !(req.token?.scopes || []).includes("admin")) {
        return res.status(403).json({ error: "admin scope required", capability: capability.slug });
      }

      const responseEndpointResult = parseResponseEndpoint(req.body.responseEndpoint);
      if (!responseEndpointResult.ok) return res.status(400).json({ error: responseEndpointResult.error });

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
      res.status(202).json(capabilityRunResponse({
        dispatched,
        registeredResponseEndpoint,
        run,
        withRunLinks
      }));
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
    sizeBytes: source.code.length,
    metadata,
    sections,
    code: source.code,
    graph
  };
}
