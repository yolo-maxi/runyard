import {
  normalizeExecutionIntent,
  resolveCapabilityVersionOptions
} from "./runExecution.js";
import { runOutputLinks } from "./runHttpPresentation.js";
import {
  presentRunResponseEndpoint,
  safeResponseEndpointAuditDetail
} from "./runResponseEndpoint.js";
import { resolveCapabilityRef } from "./repoCatalog.js";
import { actorName } from "./routeActors.js";
import { attachChainToInput } from "./workflowChain.js";
import { requestOrigin } from "./requestContext.js";

export function capabilityRunInput(body = {}) {
  const input = body.input || body || {};
  if (input && typeof input === "object" && !Array.isArray(input) && "responseEndpoint" in input) {
    delete input.responseEndpoint;
  }
  return input;
}

export function capabilityRunDispatchOptions({ body = {}, capability, env = process.env, execution, origin }) {
  const { capabilitySha: resolvedSha } = resolveCapabilityRef(capability, {
    pin: body.pin,
    env
  });
  const versionOptions = resolveCapabilityVersionOptions(
    { capabilitySha: body.pin || resolvedSha, parentRunId: body.parentRunId },
    env
  );
  return {
    runnerId: body.runnerId,
    requestedBy: origin.requestedBy,
    origin: origin.origin,
    execution,
    capabilitySha: versionOptions.capabilitySha,
    parentRunId: versionOptions.parentRunId
  };
}

export function prepareCapabilityRunRequest({ req, capability, env = process.env }) {
  const input = capabilityRunInput(req.body || {});
  attachChainToInput(input, req.body.chain);
  const execution = normalizeExecutionIntent(input, req.body || {});
  const origin = requestOrigin(req, input);
  const dispatchOptions = capabilityRunDispatchOptions({ body: req.body, capability, env, execution, origin });
  return { dispatchOptions, execution, input, origin };
}

export function registerRunResponseEndpoint({
  addRunEvent,
  createRunResponseEndpoint,
  origin,
  recordAudit,
  responseEndpoint,
  run,
  token
}) {
  if (!responseEndpoint) return null;
  const stored = createRunResponseEndpoint({
    runId: run.id,
    type: responseEndpoint.type,
    config: responseEndpoint.config,
    createdBy: actorName(token)
  });
  const auditDetail = safeResponseEndpointAuditDetail(stored);
  addRunEvent(run.id, "run.response_endpoint.registered", `Response endpoint registered (${stored.type})`, auditDetail);
  recordAudit(origin.requestedBy, "run.response_endpoint.registered", run.id, {
    runId: run.id,
    ...auditDetail
  });
  return presentRunResponseEndpoint(stored);
}

export function capabilityRunResponse({ dispatched, registeredResponseEndpoint, run, withRunLinks }) {
  return {
    run: withRunLinks(run),
    ...(registeredResponseEndpoint ? { responseEndpoint: registeredResponseEndpoint } : {}),
    ...runOutputLinks(run.id)
  };
}
