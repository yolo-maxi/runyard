import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { createRunDraftStore } from "../src/runDraftStore.js";
import { createRunDraftHandlers } from "../src/runDraftRoutes.js";
import { evaluateRunPreflight } from "../src/runPreflight.js";
import { mockResponse as response } from "./response.js";

const CAPABILITIES = new Map([
  ["research", {
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
  }],
  ["gpu-job", {
    slug: "gpu-job",
    name: "GPU Job",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    requiredRunnerTags: ["gpu"],
    workflow: { engine: "smithers", entry: "gpu.tsx" }
  }],
  ["admin-tool", {
    slug: "admin-tool",
    name: "Admin Tool",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    requiredRunnerTags: [],
    workflow: { entry: "admin.tsx", adminOnly: true }
  }]
]);

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(DB_SCHEMA_SQL);
  let sequence = 0;
  const store = createRunDraftStore({
    all: (sql, params) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params)),
    one: (sql, params) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params)),
    run: (sql, params) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params)),
    id: (prefix) => `${prefix}_${++sequence}`,
    now: () => new Date(1783000000000 + (++sequence) * 1000).toISOString(),
    scrubStoredSecrets: (value) => value
  });
  const dispatched = [];
  const audits = [];
  const notifications = [];
  const context = {
    runners: [{ id: "runner_1", name: "vps-1", tags: ["smithers", "vps", "remote"], online: true }],
    hookProfiles: [],
    secretsEnabled: false,
    secretExists: null,
    root: process.cwd()
  };
  const handlers = createRunDraftHandlers({
    ...store,
    dispatchRun: (capability, input, options) => {
      const run = { id: `run_${dispatched.length + 1}`, capabilitySlug: capability.slug, input, status: "queued" };
      dispatched.push({ capability, input, options, run });
      return { run };
    },
    evaluatePreflight: ({ capability, input, options }) => evaluateRunPreflight({ capability, input, options, context }),
    getCapability: (slug) => CAPABILITIES.get(slug) || null,
    listApprovals: () => [],
    notifyTelegram: async (approval) => notifications.push(approval),
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    withRunLinks: (run) => ({ ...run, deepLink: `#/runs/${run.id}` })
  });
  return { audits, dispatched, handlers, notifications, store };
}

function req({ body = {}, params = {}, query = {}, scopes = ["api"] } = {}) {
  return { body, params, query, headers: {}, token: { id: "tok_1", name: "operator", scopes } };
}

describe("run draft negotiation routes", () => {
  it("creates a needs_input draft for underspecified input without creating any run", () => {
    const { audits, dispatched, handlers } = harness();
    const res = response();
    handlers.createRunDraft(req({ body: { capability: "research", input: {} } }), res);

    assert.equal(res.statusCode, 201);
    const draft = res.body.draft;
    assert.equal(draft.status, "needs_input");
    assert.equal(draft.capability, "research");
    assert.ok(draft.preflight.questions.some((question) => question.field === "prompt"));
    assert.ok(draft.preflight.suggestedDefaults.title);
    assert.match(draft.nextAction, /Answer questions/);
    assert.equal(dispatched.length, 0);
    assert.equal(audits[0].action, "run_draft.created");
  });

  it("patch answers re-preflight the draft to ready, then submit enqueues the real run", async () => {
    const { dispatched, handlers } = harness();
    const created = response();
    handlers.createRunDraft(req({ body: { capability: "research", input: {}, executionMode: "remote" } }), created);
    const draftId = created.body.draft.id;

    const patched = response();
    handlers.patchRunDraft(req({
      body: { input: { prompt: "quantum computing", title: "Research quantum" } },
      params: { id: draftId }
    }), patched);
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.body.draft.status, "ready");
    assert.equal(patched.body.draft.input.prompt, "quantum computing");
    assert.equal(dispatched.length, 0);

    const submitted = response();
    await handlers.submitRunDraft(req({ params: { id: draftId } }), submitted);
    assert.equal(submitted.statusCode, 202);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].capability.slug, "research");
    assert.equal(dispatched[0].options.origin.draftId, draftId);
    assert.equal(dispatched[0].options.execution.mode, "remote");
    assert.equal(submitted.body.draft.status, "submitted");
    assert.equal(submitted.body.draft.runId, submitted.body.run.id);
    assert.equal(submitted.body.negotiation.status, "ready");
    assert.ok(submitted.body.statusUrl || submitted.body.logsUrl);
  });

  it("refuses to submit a non-ready draft: needs_input is 422, blocked is 409, nothing enqueues", async () => {
    const { dispatched, handlers } = harness();
    const created = response();
    handlers.createRunDraft(req({ body: { capability: "research", input: {} } }), created);
    const needsInput = response();
    await handlers.submitRunDraft(req({ params: { id: created.body.draft.id } }), needsInput);
    assert.equal(needsInput.statusCode, 422);
    assert.equal(needsInput.body.negotiation.status, "needs_input");

    const blockedDraft = response();
    handlers.createRunDraft(req({ body: { capability: "gpu-job", input: {} } }), blockedDraft);
    assert.equal(blockedDraft.body.draft.status, "blocked");
    const blocked = response();
    await handlers.submitRunDraft(req({ params: { id: blockedDraft.body.draft.id } }), blocked);
    assert.equal(blocked.statusCode, 409);
    assert.ok(blocked.body.negotiation.blockers.some((entry) => entry.code === "no_matching_runner"));

    assert.equal(dispatched.length, 0);
  });

  it("locks drafts after submit or discard and 404s unknown drafts/capabilities", async () => {
    const { handlers } = harness();
    const created = response();
    handlers.createRunDraft(req({ body: { capability: "research", input: { prompt: "x", title: "T" } } }), created);
    const draftId = created.body.draft.id;
    await handlers.submitRunDraft(req({ params: { id: draftId } }), response());

    const patchAfterSubmit = response();
    handlers.patchRunDraft(req({ body: { input: { prompt: "y" } }, params: { id: draftId } }), patchAfterSubmit);
    assert.equal(patchAfterSubmit.statusCode, 409);
    assert.match(patchAfterSubmit.body.error, /submitted/);

    const resubmit = response();
    await handlers.submitRunDraft(req({ params: { id: draftId } }), resubmit);
    assert.equal(resubmit.statusCode, 409);

    const missing = response();
    handlers.getRunDraft(req({ params: { id: "draft_missing" } }), missing);
    assert.equal(missing.statusCode, 404);

    const unknownCapability = response();
    handlers.createRunDraft(req({ body: { capability: "nope" } }), unknownCapability);
    assert.equal(unknownCapability.statusCode, 404);

    const noCapability = response();
    handlers.createRunDraft(req({ body: {} }), noCapability);
    assert.equal(noCapability.statusCode, 400);
  });

  it("keeps adminOnly workflows admin-scoped and supports discard + list filters", () => {
    const { handlers } = harness();
    const forbidden = response();
    handlers.createRunDraft(req({ body: { capability: "admin-tool" } }), forbidden);
    assert.equal(forbidden.statusCode, 403);

    const allowed = response();
    handlers.createRunDraft(req({ body: { capability: "admin-tool" }, scopes: ["api", "admin"] }), allowed);
    assert.equal(allowed.statusCode, 201);

    const discarded = response();
    handlers.discardRunDraft(req({ params: { id: allowed.body.draft.id } }), discarded);
    assert.equal(discarded.body.draft.status, "discarded");

    const list = response();
    handlers.listRunDrafts(req({ query: { status: "discarded" } }), list);
    assert.equal(list.body.drafts.length, 1);
    assert.equal(list.body.drafts[0].id, allowed.body.draft.id);
  });
});
