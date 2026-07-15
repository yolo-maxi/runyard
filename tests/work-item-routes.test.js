import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWorkItemHandlers } from "../src/workItemRoutes.js";
import { validateWorkItemBody, withWorkItemView, workItemRunRollup } from "../src/workItemHelpers.js";
import { mockResponse } from "./response.js";

const baseItem = {
  id: "wi_1",
  title: "Ship the board",
  description: "",
  project: "runyard",
  type: "feature",
  status: "ready",
  priority: "normal",
  owner: "",
  requester: "",
  acceptanceCriteria: "",
  nextAction: "",
  blockedReason: "",
  dueAt: null,
  createdBy: "tester",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z"
};

function req({ body = {}, params = {}, query = {}, token = { name: "tester", scopes: ["api"] } } = {}) {
  return { body, params, query, token };
}

function createHarness(overrides = {}) {
  const audits = [];
  const deps = {
    createWorkItem: (input) => ({ ...baseItem, ...input }),
    deleteWorkItem: (id) => (id === baseItem.id ? baseItem : null),
    getWorkItem: (id) => (id === baseItem.id ? baseItem : null),
    linkRunToWorkItem: () => ({ ok: true, workItem: baseItem, runId: "run_1" }),
    listApprovals: () => [{ id: "appr_1", runId: "run_1", status: "pending" }, { id: "appr_2", runId: "other", status: "pending" }],
    listArtifacts: ({ runId }) => (runId === "run_1" ? [{ id: "art_1", runId }] : []),
    listWorkItemEvents: () => [{ id: "wie_1", type: "work_item.created" }],
    listWorkItemRuns: () => [{ id: "run_1", status: "running", createdAt: "2026-07-15T01:00:00.000Z" }],
    listWorkItems: () => [baseItem],
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    unlinkRunFromWorkItem: () => ({ ok: true, workItem: baseItem, runId: "run_1" }),
    updateWorkItem: (id, updates) => ({ ...baseItem, ...updates }),
    withRunLinks: (run) => ({ ...run, deepLink: `/app#runs/${run.id}` }),
    workItemRunSummaries: () => new Map([[baseItem.id, { total: 2, byStatus: { running: 1, paused: 1 }, lastRunAt: "2026-07-15T01:00:00.000Z" }]]),
    ...overrides
  };
  return { audits, handlers: createWorkItemHandlers(deps) };
}

describe("work item helpers", () => {
  it("validates create bodies: title required, enums enforced, lengths bounded", () => {
    assert.equal(validateWorkItemBody({}).ok, false);
    assert.equal(validateWorkItemBody({ title: "x", status: "failed" }).ok, false);
    assert.equal(validateWorkItemBody({ title: "x", type: "epic" }).ok, false);
    assert.equal(validateWorkItemBody({ title: "x", priority: "p0" }).ok, false);
    assert.equal(validateWorkItemBody({ title: "x", dueAt: "not-a-date" }).ok, false);
    assert.equal(validateWorkItemBody({ title: "x".repeat(201) }).ok, false);
    assert.equal(validateWorkItemBody({ title: 42 }).ok, false);

    const valid = validateWorkItemBody({ title: "  Ship it  ", status: "blocked", blockedReason: "creds", dueAt: "2026-08-01" });
    assert.equal(valid.ok, true);
    assert.equal(valid.value.title, "Ship it");
    assert.equal(valid.value.status, "blocked");
    assert.match(valid.value.dueAt, /^2026-08-01T/);

    // PATCH mode: fields optional, but the title cannot be cleared.
    assert.equal(validateWorkItemBody({}, { partial: true }).ok, true);
    assert.equal(validateWorkItemBody({ title: " " }, { partial: true }).ok, false);
    assert.deepEqual(validateWorkItemBody({ nextAction: "" }, { partial: true }).value, { nextAction: "" });
  });

  it("decorates views with deep links and attention rollups", () => {
    const view = withWorkItemView(baseItem, { total: 3, byStatus: { paused: 1, waiting_approval: 1, succeeded: 1 }, lastRunAt: "t" });
    assert.equal(view.deepLink, "/app#work/wi_1");
    assert.equal(view.deepLinkFlow, "/app#work/wi_1/flow");
    assert.equal(view.runs.attention, 2);
    assert.deepEqual(workItemRunRollup(null), { total: 0, byStatus: {}, lastRunAt: null, attention: 0 });
  });
});

describe("work item routes", () => {
  it("lists work items with run rollups", () => {
    const { handlers } = createHarness();
    const res = mockResponse();
    handlers.listWorkItems(req(), res);
    assert.equal(res.body.workItems.length, 1);
    assert.equal(res.body.workItems[0].runs.total, 2);
    assert.equal(res.body.workItems[0].runs.attention, 1);
    assert.equal(res.body.workItems[0].deepLink, "/app#work/wi_1");
  });

  it("returns 404 for unknown items and 400 for invalid bodies", () => {
    const { handlers } = createHarness();
    const missing = mockResponse();
    handlers.getWorkItem(req({ params: { id: "wi_missing" } }), missing);
    assert.equal(missing.statusCode, 404);

    const invalid = mockResponse();
    handlers.createWorkItem(req({ body: { title: "" } }), invalid);
    assert.equal(invalid.statusCode, 400);

    const badStatus = mockResponse();
    handlers.updateWorkItem(req({ params: { id: "wi_1" }, body: { status: "failed" } }), badStatus);
    assert.equal(badStatus.statusCode, 400);
  });

  it("assembles the ticket detail: runs, only this ticket's approvals, artifacts, history", () => {
    const { handlers } = createHarness();
    const res = mockResponse();
    handlers.getWorkItem(req({ params: { id: "wi_1" } }), res);
    assert.equal(res.body.workItem.id, "wi_1");
    assert.deepEqual(res.body.runs.map((run) => run.id), ["run_1"]);
    assert.equal(res.body.runs[0].deepLink, "/app#runs/run_1");
    assert.deepEqual(res.body.approvals.map((approval) => approval.id), ["appr_1"]);
    assert.deepEqual(res.body.artifacts.map((artifact) => artifact.id), ["art_1"]);
    assert.equal(res.body.events.length, 1);
    // Rollup derived from the fetched runs, not a second query.
    assert.equal(res.body.workItem.runs.total, 1);
  });

  it("creates and updates with audit entries and actor attribution", () => {
    const { audits, handlers } = createHarness();
    const created = mockResponse();
    handlers.createWorkItem(req({ body: { title: "New ticket" } }), created);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.workItem.title, "New ticket");
    assert.equal(created.body.workItem.createdBy, "tester");
    assert.equal(created.body.workItem.requester, "tester");
    assert.equal(audits[0].action, "work_item.created");

    const updated = mockResponse();
    handlers.updateWorkItem(req({ params: { id: "wi_1" }, body: { status: "review" } }), updated);
    assert.equal(updated.body.workItem.status, "review");
    assert.equal(audits[1].action, "work_item.updated");
  });

  it("links and unlinks runs, propagating store errors as status codes", () => {
    const { audits, handlers } = createHarness();
    const linked = mockResponse();
    handlers.linkWorkItemRun(req({ params: { id: "wi_1" }, body: { runId: "run_1" } }), linked);
    assert.equal(linked.body.linked, true);
    assert.equal(audits[0].action, "work_item.run_linked");

    const noRun = mockResponse();
    handlers.linkWorkItemRun(req({ params: { id: "wi_1" }, body: {} }), noRun);
    assert.equal(noRun.statusCode, 400);

    const { handlers: failing } = createHarness({
      unlinkRunFromWorkItem: () => ({ ok: false, error: "run is not linked to this work item", code: 409 })
    });
    const conflict = mockResponse();
    failing.unlinkWorkItemRun(req({ params: { id: "wi_1" }, body: { runId: "run_9" } }), conflict);
    assert.equal(conflict.statusCode, 409);
  });

  it("deletes with a 404 on unknown ids", () => {
    const { handlers } = createHarness();
    const ok = mockResponse();
    handlers.deleteWorkItem(req({ params: { id: "wi_1" } }), ok);
    assert.equal(ok.body.deleted, true);
    const missing = mockResponse();
    handlers.deleteWorkItem(req({ params: { id: "nope" } }), missing);
    assert.equal(missing.statusCode, 404);
  });
});
