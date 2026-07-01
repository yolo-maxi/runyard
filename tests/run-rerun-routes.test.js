import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRunRerunHandlers,
  rerunAcceptedResponse
} from "../src/runRerunRoutes.js";
import { mockResponse as response } from "./response.js";

function req({ body = {}, params = { id: "run_prev" }, scopes = ["api"] } = {}) {
  return {
    body,
    headers: {},
    params,
    token: { id: "tok_1", name: "operator", scopes }
  };
}

function harness(overrides = {}) {
  const events = [];
  const dispatched = [];
  const notifications = [];
  const runs = new Map([
    ["run_prev", {
      id: "run_prev",
      status: "succeeded",
      capabilitySlug: "research",
      input: { prompt: "status", __origin: { label: "old" } }
    }],
    ["run_existing", {
      id: "run_existing",
      status: "queued",
      capabilitySlug: "research",
      input: { prompt: "status", rerunOf: "run_prev" }
    }],
    ...(overrides.runs || []).map((run) => [run.id, run])
  ]);
  const capabilities = new Map([
    ["research", { slug: "research", name: "Research", enabled: true }],
    ["disabled", { slug: "disabled", name: "Disabled", enabled: false }],
    ...(overrides.capabilities || []).map((capability) => [capability.slug, capability])
  ]);
  const handlers = createRunRerunHandlers({
    addRunEvent: (runId, type, message, detail) => events.push({ runId, type, message, detail }),
    dispatchRun: (capability, input, options) => {
      const run = { id: `run_new_${dispatched.length + 1}`, capabilitySlug: capability.slug, input, status: "queued" };
      dispatched.push({ capability, input, options, run });
      return { run, supervising: overrides.supervising, supervisedChild: overrides.supervisedChild };
    },
    getCapability: (slug) => capabilities.get(slug) || null,
    getRun: (id) => runs.get(id) || null,
    listApprovals: () => overrides.pendingApprovals || [],
    listRuns: (options) => {
      assert.deepEqual(options, { limit: 500, includeInternal: true });
      return Array.from(runs.values());
    },
    notifyTelegram: async (approval) => notifications.push(approval),
    withRunLinks: (run) => ({ ...run, deepLink: `/app#runs/${run.id}` })
  });
  return { dispatched, events, handlers, notifications, runs };
}

describe("run rerun route helpers", () => {
  it("builds accepted rerun responses for new and deduped runs", () => {
    const withRunLinks = (run) => ({ ...run, deepLink: `/app#runs/${run.id}` });
    const previous = { id: "run_prev" };
    const run = { id: "run_new" };

    assert.deepEqual(rerunAcceptedResponse({
      dispatched: { supervising: { parentRunId: "run_supervisor" } },
      previous,
      run,
      withRunLinks
    }), {
      run: { id: "run_new", deepLink: "/app#runs/run_new" },
      supervising: { parentRunId: "run_supervisor" },
      previousRun: { id: "run_prev", deepLink: "/app#runs/run_prev" },
      statusUrl: "/api/runs/run_new",
      webUrl: "/app#runs/run_new",
      deepLink: "/app#runs/run_new"
    });

    assert.deepEqual(rerunAcceptedResponse({
      deduped: true,
      previous,
      run,
      withRunLinks
    }), {
      deduped: true,
      run: { id: "run_new", deepLink: "/app#runs/run_new" },
      previousRun: { id: "run_prev", deepLink: "/app#runs/run_prev" },
      statusUrl: "/api/runs/run_new",
      webUrl: "/app#runs/run_new",
      deepLink: "/app#runs/run_new"
    });
  });

  it("returns 404 for missing runs or unavailable capabilities", async () => {
    const missing = harness();
    const missingRes = response();
    await missing.handlers.rerunRun(req({ params: { id: "missing" } }), missingRes);
    assert.equal(missingRes.statusCode, 404);
    assert.equal(missingRes.body.error, "run not found");

    const unavailable = harness({
      runs: [{ id: "run_disabled", capabilitySlug: "disabled", input: {}, status: "failed" }]
    });
    const unavailableRes = response();
    await unavailable.handlers.rerunRun(req({ params: { id: "run_disabled" } }), unavailableRes);
    assert.equal(unavailableRes.statusCode, 404);
    assert.equal(unavailableRes.body.error, "capability not found");
  });

  it("dedupes active matching reruns unless forced", async () => {
    const { dispatched, events, handlers } = harness();
    const res = response();

    await handlers.rerunRun(req(), res);

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.deduped, true);
    assert.equal(res.body.run.id, "run_existing");
    assert.equal(res.body.deepLink, "/app#runs/run_existing");
    assert.equal(dispatched.length, 0);
    assert.equal(events[0].type, "run.rerun_deduped");
  });

  it("dispatches forced reruns with cleaned input and lineage events", async () => {
    const { dispatched, events, handlers } = harness({
      supervising: { supervisor: "run-smithers" },
      supervisedChild: { parentRunId: "run_parent" }
    });
    const res = response();

    await handlers.rerunRun(req({
      body: {
        force: true,
        input: {
          prompt: "fresh",
          __origin: { label: "remove" },
          __supervisionToken: "secret",
          __supervisedChild: { token: "remove" }
        }
      }
    }), res);

    assert.equal(res.statusCode, 202);
    assert.deepEqual(dispatched[0].input, { prompt: "fresh", rerunOf: "run_prev" });
    assert.equal(dispatched[0].options.requestedBy, "token: operator");
    assert.equal(dispatched[0].options.origin.type, "hub-rerun");
    assert.equal(dispatched[0].options.origin.previousRunId, "run_prev");
    assert.deepEqual(events.map((event) => event.type), ["run.rerun_requested", "run.rerun_of"]);
    assert.equal(res.body.run.id, "run_new_1");
    assert.deepEqual(res.body.supervising, { supervisor: "run-smithers" });
    assert.deepEqual(res.body.supervisedChild, { parentRunId: "run_parent" });
    assert.equal(res.body.statusUrl, "/api/runs/run_new_1");
  });

  it("notifies Telegram when the rerun creates a pending approval", async () => {
    const { handlers, notifications } = harness({
      pendingApprovals: [{ id: "approval_1", runId: "run_new_1" }]
    });
    const res = response();

    await handlers.rerunRun(req({ body: { force: true } }), res);

    assert.deepEqual(notifications, [{ id: "approval_1", runId: "run_new_1" }]);
  });
});
