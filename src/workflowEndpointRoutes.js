import { bearerFromRequest, requireBodySlug } from "./requestContext.js";
import { actorName } from "./routeActors.js";
import { runOutputLinks, runStatusLinks } from "./runHttpPresentation.js";
import { hashToken, timingSafeEqualStr } from "./security.js";
import {
  bodySizeBytes,
  workflowEndpointPayloadHash,
  workflowEndpointRunInput
} from "./workflowEndpointSubmission.js";

export function createWorkflowEndpointHandlers({
  addRunEvent,
  countWorkflowEndpointInvocations,
  createRun,
  findRecentWorkflowEndpointInvocation,
  getCapability,
  getRun,
  getWorkflowEndpoint,
  listWorkflowEndpoints,
  recordAudit,
  recordWorkflowEndpointInvocation,
  upsertWorkflowEndpoint,
  withRunLinks,
  nowMs = () => Date.now()
} = {}) {
  return {
    listWorkflowEndpoints(req, res) {
      const includeDisabled = req.query.all === "1";
      res.json({ endpoints: listWorkflowEndpoints({ includeDisabled }) });
    },

    upsertWorkflowEndpoint(req, res) {
      try {
        const endpoint = upsertWorkflowEndpoint(
          {
            ...req.body,
            slug: requireBodySlug(req.body, "workflow-endpoint"),
            capabilitySlug: req.body.capabilitySlug || req.body.capability_slug || "improve-no-deploy"
          },
          workflowEndpointSecretOptions(req.body)
        );
        recordAudit(actorName(req.token), "workflow_endpoint.upserted", endpoint.id, {
          ...workflowEndpointAuditDetail(endpoint),
          capabilitySlug: endpoint.capabilitySlug
        });
        res.json({ endpoint });
      } catch (error) {
        res.status(400).json({ error: error.message || "invalid workflow endpoint" });
      }
    },

    getWorkflowEndpoint(req, res) {
      const endpoint = getWorkflowEndpoint(req.params.endpointSlug, { includeDisabled: true });
      if (!endpoint) return res.status(404).json({ error: "workflow endpoint not found" });
      res.json({ endpoint });
    },

    submitWorkflowEndpoint(req, res) {
      const endpoint = getWorkflowEndpoint(req.params.endpointSlug, { includeSecretHash: true });
      const presented = bearerFromRequest(req) || String(req.headers["x-smithers-endpoint-secret"] || "").trim();
      if (!endpoint || !presented || !timingSafeEqualStr(hashToken(presented), endpoint.secretHash)) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const sizeBytes = bodySizeBytes(req);
      if (sizeBytes > endpoint.maxPayloadBytes) {
        recordAudit(workflowEndpointActor(endpoint), "workflow_endpoint.payload_too_large", endpoint.id, {
          ...workflowEndpointAuditDetail(endpoint),
          sizeBytes,
          maxPayloadBytes: endpoint.maxPayloadBytes
        });
        return res.status(413).json({ error: "payload too large", maxPayloadBytes: endpoint.maxPayloadBytes });
      }

      const payloadHash = workflowEndpointPayloadHash(req.body || {});
      const built = workflowEndpointRunInput(endpoint, req.body || {}, { payloadHash });
      if (!built.ok) return res.status(built.code).json({ error: built.error });

      const rateSince = new Date(nowMs() - endpoint.rateLimitWindowMs).toISOString();
      const recentCount = countWorkflowEndpointInvocations(endpoint.id, rateSince);
      if (recentCount >= endpoint.rateLimitCount) {
        recordAudit(workflowEndpointActor(endpoint), "workflow_endpoint.rate_limited", endpoint.id, workflowEndpointSubmissionDetail(endpoint, {
          payloadHash,
          source: built.source
        }));
        res.setHeader("retry-after", Math.ceil(endpoint.rateLimitWindowMs / 1000));
        return res.status(429).json({ error: "too many requests" });
      }

      const deduped = dedupeWorkflowEndpointRun({
        built,
        endpoint,
        findRecentWorkflowEndpointInvocation,
        getRun,
        nowMs,
        payloadHash,
        recordAudit,
        recordWorkflowEndpointInvocation,
        withRunLinks
      });
      if (deduped) return res.status(202).json(deduped);

      const capability = getCapability(endpoint.capabilitySlug);
      if (!capability || !capability.enabled) {
        recordAudit(workflowEndpointActor(endpoint), "workflow_endpoint.misconfigured", endpoint.id, {
          ...workflowEndpointAuditDetail(endpoint),
          capabilitySlug: endpoint.capabilitySlug,
          payloadHash
        });
        return res.status(500).json({ error: "workflow endpoint is misconfigured" });
      }

      const run = createRun(capability, built.input, workflowEndpointRunOptions(endpoint, built.source, payloadHash));
      recordWorkflowEndpointInvocation({ endpoint, payloadHash, source: built.source, runId: run.id, status: "queued" });
      addRunEvent(run.id, "workflow_endpoint.queued", `Queued by workflow endpoint ${endpoint.slug}`, {
        ...workflowEndpointAuditDetail(endpoint),
        payloadHash,
        source: built.source
      });
      recordAudit(workflowEndpointActor(endpoint), "workflow_endpoint.queued", run.id, workflowEndpointSubmissionDetail(endpoint, {
        runId: run.id,
        capabilitySlug: capability.slug,
        payloadHash,
        source: built.source,
        sizeBytes
      }));
      res.status(202).json(queuedWorkflowEndpointResponse(endpoint, run, payloadHash, withRunLinks));
    }
  };
}

function workflowEndpointSecretOptions(body = {}) {
  const secret = body.secret || body.apiKey || body.token;
  return secret ? { secret } : {};
}

export function workflowEndpointActor(endpoint) {
  return `workflow-endpoint:${endpoint.slug}`;
}

export function workflowEndpointAuditDetail(endpoint, detail = {}) {
  return {
    endpointSlug: endpoint.slug,
    ...detail
  };
}

export function workflowEndpointSubmissionDetail(endpoint, { payloadHash, source = {}, ...detail } = {}) {
  return workflowEndpointAuditDetail(endpoint, {
    payloadHash,
    source,
    ...detail
  });
}

function dedupeWorkflowEndpointRun({
  built,
  endpoint,
  findRecentWorkflowEndpointInvocation,
  getRun,
  nowMs,
  payloadHash,
  recordAudit,
  recordWorkflowEndpointInvocation,
  withRunLinks
}) {
  if (endpoint.dedupeWindowMs <= 0) return null;
  const dedupeSince = new Date(nowMs() - endpoint.dedupeWindowMs).toISOString();
  const recent = findRecentWorkflowEndpointInvocation(endpoint.id, payloadHash, dedupeSince);
  if (!recent) return null;

  const run = getRun(recent.runId);
  recordWorkflowEndpointInvocation({ endpoint, payloadHash, source: built.source, runId: recent.runId, status: "deduped" });
  recordAudit(workflowEndpointActor(endpoint), "workflow_endpoint.deduped", recent.runId, workflowEndpointSubmissionDetail(endpoint, {
    runId: recent.runId,
    payloadHash,
    source: built.source
  }));
  return {
    endpoint: { slug: endpoint.slug },
    deduped: true,
    run: run ? withRunLinks(run) : null,
    ...runStatusLinks(recent.runId)
  };
}

function workflowEndpointRunOptions(endpoint, source, payloadHash) {
  return {
    requestedBy: `workflow-endpoint: ${endpoint.slug}`,
    origin: {
      label: `workflow endpoint: ${endpoint.slug}`,
      type: "workflow-endpoint",
      endpointSlug: endpoint.slug,
      app: source.app,
      user: source.user,
      session: source.session,
      payloadHash
    }
  };
}

function queuedWorkflowEndpointResponse(endpoint, run, payloadHash, withRunLinks) {
  return {
    endpoint: { slug: endpoint.slug },
    deduped: false,
    run: withRunLinks(run),
    ...runOutputLinks(run.id),
    payloadHash
  };
}
