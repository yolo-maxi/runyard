import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorkflowEndpointHandlers,
  workflowEndpointActor,
  workflowEndpointAuditDetail,
  workflowEndpointSubmissionDetail
} from "../src/workflowEndpointRoutes.js";
import { hashToken } from "../src/security.js";
import { mockResponse as response } from "./response.js";

function harness(overrides = {}) {
  const audits = [];
  const events = [];
  const invocations = [];
  const createdRuns = [];
  const endpoint = {
    id: "wep_1",
    slug: "feedback",
    name: "Feedback",
    capabilitySlug: "improve-no-deploy",
    config: { target: "Product feedback" },
    secretHash: hashToken("secret"),
    maxPayloadBytes: 10_000,
    rateLimitWindowMs: 60_000,
    rateLimitCount: 10,
    dedupeWindowMs: 60_000,
    ...overrides.endpoint
  };
  const run = { id: "run_1", capabilitySlug: "improve-no-deploy", input: {} };
  const handlers = createWorkflowEndpointHandlers({
    addRunEvent: (runId, type, message, detail) => events.push({ runId, type, message, detail }),
    countWorkflowEndpointInvocations: overrides.countWorkflowEndpointInvocations || (() => 0),
    createRun: (capability, input, options) => {
      const created = { ...run, id: `run_${createdRuns.length + 1}`, capabilitySlug: capability.slug, input, options };
      createdRuns.push(created);
      return created;
    },
    findRecentWorkflowEndpointInvocation: overrides.findRecentWorkflowEndpointInvocation || (() => null),
    getCapability: overrides.getCapability || ((slug) => ({ slug, enabled: true })),
    getRun: overrides.getRun || ((id) => ({ id, capabilitySlug: "improve-no-deploy" })),
    getWorkflowEndpoint: overrides.getWorkflowEndpoint || (() => endpoint),
    listWorkflowEndpoints: overrides.listWorkflowEndpoints || (() => [endpoint]),
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    recordWorkflowEndpointInvocation: (invocation) => invocations.push(invocation),
    upsertWorkflowEndpoint: overrides.upsertWorkflowEndpoint || ((body, options) => ({ id: "wep_new", ...body, secret: options.secret || "" })),
    withRunLinks: (item) => ({ ...item, deepLink: `#/runs/${item.id}` }),
    nowMs: () => Date.UTC(2026, 0, 1)
  });
  return { audits, createdRuns, endpoint, events, handlers, invocations };
}

function submitReq(body = {}, headers = {}) {
  return {
    params: { endpointSlug: "feedback" },
    headers: { authorization: "Bearer secret", ...headers },
    body
  };
}

describe("workflow endpoint route handlers", () => {
  it("builds consistent workflow endpoint audit details", () => {
    const endpoint = { slug: "feedback" };

    assert.equal(workflowEndpointActor(endpoint), "workflow-endpoint:feedback");
    assert.deepEqual(workflowEndpointAuditDetail(endpoint, { runId: "run_1" }), {
      endpointSlug: "feedback",
      runId: "run_1"
    });
    assert.deepEqual(workflowEndpointSubmissionDetail(endpoint, {
      payloadHash: "hash_1",
      source: { app: "mobile" },
      runId: "run_1"
    }), {
      endpointSlug: "feedback",
      payloadHash: "hash_1",
      source: { app: "mobile" },
      runId: "run_1"
    });
  });

  it("lists and upserts endpoints with normalized defaults", () => {
    const { audits, handlers } = harness();
    const listRes = response();
    handlers.listWorkflowEndpoints({ query: { all: "1" } }, listRes);
    assert.equal(listRes.body.endpoints[0].slug, "feedback");

    const upsertRes = response();
    handlers.upsertWorkflowEndpoint({
      token: { name: "admin" },
      body: { name: "Mobile Feedback", apiKey: "new-secret" }
    }, upsertRes);
    assert.equal(upsertRes.body.endpoint.slug, "mobile-feedback");
    assert.equal(upsertRes.body.endpoint.capabilitySlug, "improve-no-deploy");
    assert.equal(upsertRes.body.endpoint.secret, "new-secret");
    assert.equal(audits[0].action, "workflow_endpoint.upserted");
  });

  it("queues a valid endpoint submission and records audit/event metadata", () => {
    const { audits, createdRuns, events, handlers, invocations } = harness();
    const res = response();
    handlers.submitWorkflowEndpoint(submitReq({
      feedback: { text: "Run details are hard to scan." },
      app: "mobile",
      user: "ada",
      session: "s1"
    }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.deduped, false);
    assert.equal(res.body.run.id, "run_1");
    assert.equal(createdRuns[0].options.requestedBy, "workflow-endpoint: feedback");
    assert.equal(createdRuns[0].options.origin.type, "workflow-endpoint");
    assert.equal(createdRuns[0].input.untrustedFeedback.text, "Run details are hard to scan.");
    assert.equal(invocations[0].status, "queued");
    assert.equal(events[0].type, "workflow_endpoint.queued");
    assert.equal(audits[0].action, "workflow_endpoint.queued");
  });

  it("dedupes repeated submissions inside the endpoint window", () => {
    const { audits, createdRuns, handlers, invocations } = harness({
      findRecentWorkflowEndpointInvocation: () => ({ runId: "run_existing" })
    });
    const res = response();
    handlers.submitWorkflowEndpoint(submitReq({ feedback: "same feedback" }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.deduped, true);
    assert.equal(res.body.run.id, "run_existing");
    assert.equal(createdRuns.length, 0);
    assert.equal(invocations[0].status, "deduped");
    assert.equal(audits[0].action, "workflow_endpoint.deduped");
  });

  it("rejects unauthorized, oversized, and rate-limited submissions before creating runs", () => {
    const unauthorized = harness();
    const unauthorizedRes = response();
    unauthorized.handlers.submitWorkflowEndpoint(submitReq({ feedback: "x" }, { authorization: "Bearer wrong" }), unauthorizedRes);
    assert.equal(unauthorizedRes.statusCode, 401);
    assert.equal(unauthorized.createdRuns.length, 0);

    const oversized = harness({ endpoint: { maxPayloadBytes: 1 } });
    const oversizedRes = response();
    oversized.handlers.submitWorkflowEndpoint(submitReq({ feedback: "too large" }), oversizedRes);
    assert.equal(oversizedRes.statusCode, 413);
    assert.equal(oversized.audits[0].action, "workflow_endpoint.payload_too_large");

    const limited = harness({ countWorkflowEndpointInvocations: () => 10 });
    const limitedRes = response();
    limited.handlers.submitWorkflowEndpoint(submitReq({ feedback: "valid feedback" }), limitedRes);
    assert.equal(limitedRes.statusCode, 429);
    assert.equal(limitedRes.headers["retry-after"], 60);
    assert.equal(limited.audits[0].action, "workflow_endpoint.rate_limited");
    assert.equal(limited.createdRuns.length, 0);
  });
});
