import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCapabilityHandlers } from "../src/capabilityRoutes.js";
import { evaluateRunPreflight } from "../src/runPreflight.js";
import { mockResponse as response } from "./response.js";

const RESEARCH = {
  slug: "research",
  name: "Research",
  enabled: true,
  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: { prompt: { type: "string", description: "The research question or topic." } }
  },
  requiredRunnerTags: ["smithers"],
  workflow: { engine: "smithers", entry: "research.tsx" }
};

const GPU_JOB = {
  slug: "gpu-job",
  name: "GPU Job",
  enabled: true,
  inputSchema: { type: "object", properties: {} },
  requiredRunnerTags: ["gpu"],
  workflow: { engine: "smithers", entry: "gpu.tsx" }
};

function harness() {
  const dispatched = [];
  const drafts = [];
  const capabilities = new Map([[RESEARCH.slug, RESEARCH], [GPU_JOB.slug, GPU_JOB]]);
  const context = {
    runners: [{ id: "runner_1", name: "vps-1", tags: ["smithers", "vps", "remote"], online: true }],
    hookProfiles: [],
    secretsEnabled: false,
    secretExists: null,
    root: process.cwd()
  };
  const handlers = createCapabilityHandlers({
    addRunEvent: () => {},
    createRunDraft: (input) => {
      const draft = {
        id: `draft_${drafts.length + 1}`,
        capabilitySlug: input.capabilitySlug,
        input: input.input,
        options: input.options,
        status: input.status,
        preflight: input.preflight,
        createdBy: input.createdBy,
        runId: null,
        createdAt: "2026-07-06T00:00:00.000Z",
        updatedAt: "2026-07-06T00:00:00.000Z"
      };
      drafts.push(draft);
      return draft;
    },
    createRunResponseEndpoint: () => null,
    dispatchRun: (capability, input, options) => {
      const run = { id: `run_${dispatched.length + 1}`, capabilitySlug: capability.slug, input, status: "queued" };
      dispatched.push({ capability, input, options, run });
      return { run };
    },
    evaluatePreflight: ({ capability, input, options }) => evaluateRunPreflight({ capability, input, options, context }),
    getCapability: (slug) => capabilities.get(slug) || null,
    getWorkflowBundle: () => null,
    listApprovals: () => [],
    listCapabilities: () => [],
    listCapabilityVersionsFromRuns: () => [],
    notifyTelegram: async () => {},
    recordAudit: () => {},
    root: process.cwd(),
    upsertCapability: (body) => body,
    withCapabilityLinks: (capability) => capability,
    withRunLinks: (run) => ({ ...run, deepLink: `#/runs/${run.id}` }),
    env: {}
  });
  return { dispatched, drafts, handlers };
}

function req({ body = {}, params = {}, scopes = ["api"] } = {}) {
  return { body, params, query: {}, headers: {}, token: { id: "tok_1", name: "operator", scopes } };
}

describe("negotiated capability create", () => {
  it("negotiate + ready input enqueues normally and exposes the preflight result", async () => {
    const { dispatched, drafts, handlers } = harness();
    const res = response();
    await handlers.runCapability(req({
      body: { negotiate: true, input: { prompt: "quantum computing", title: "Research quantum" } },
      params: { id: "research" }
    }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(dispatched.length, 1);
    assert.equal(drafts.length, 0);
    assert.equal(res.body.run.id, "run_1");
    assert.equal(res.body.negotiation.status, "ready");
    assert.equal(res.body.negotiation.input.title, "Research quantum");
  });

  it("negotiate + missing required input returns 422 with a draft and never creates a run", async () => {
    const { dispatched, drafts, handlers } = harness();
    const res = response();
    await handlers.runCapability(req({
      body: { negotiate: true, input: {} },
      params: { id: "research" }
    }), res);

    assert.equal(res.statusCode, 422);
    assert.equal(dispatched.length, 0);
    assert.equal(res.body.negotiation.status, "needs_input");
    assert.ok(res.body.negotiation.questions.some((question) => question.field === "prompt"));
    assert.equal(drafts.length, 1);
    assert.equal(res.body.draft.id, "draft_1");
    assert.equal(res.body.draft.status, "needs_input");
    assert.match(res.body.error, /needs_input/);
  });

  it("negotiate + hard blocker returns 409 without enqueueing", async () => {
    const { dispatched, handlers } = harness();
    const res = response();
    await handlers.runCapability(req({
      body: { negotiate: true, input: {} },
      params: { id: "gpu-job" }
    }), res);

    assert.equal(res.statusCode, 409);
    assert.equal(dispatched.length, 0);
    assert.equal(res.body.negotiation.status, "blocked");
    assert.ok(res.body.negotiation.blockers.some((blocker) => blocker.code === "no_matching_runner"));
  });

  it("without negotiate, create behavior is unchanged even for underspecified input", async () => {
    const { dispatched, drafts, handlers } = harness();
    const res = response();
    await handlers.runCapability(req({
      body: { input: {} },
      params: { id: "research" }
    }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(dispatched.length, 1);
    assert.equal(drafts.length, 0);
    assert.equal(res.body.negotiation, undefined);
  });

  it("POST /preflight reports the negotiation state without creating or storing anything", () => {
    const { dispatched, drafts, handlers } = harness();
    const res = response();
    handlers.preflightCapability(req({
      body: { input: { prompt: "quantum computing" } },
      params: { id: "research" }
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.negotiation.status, "ready");
    assert.ok(res.body.negotiation.warnings.some((warning) => warning.code === "title_missing"));
    assert.equal(res.body.negotiation.suggestedDefaults.title, "Research: quantum computing");
    assert.equal(dispatched.length, 0);
    assert.equal(drafts.length, 0);

    const missing = response();
    handlers.preflightCapability(req({ body: {}, params: { id: "nope" } }), missing);
    assert.equal(missing.statusCode, 404);
  });
});
