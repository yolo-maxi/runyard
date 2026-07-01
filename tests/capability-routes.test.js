import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createCapabilityHandlers
} from "../src/capabilityRoutes.js";
import { MAX_WORKFLOW_BUNDLE_BYTES } from "../src/workflowSource.js";
import { mockResponse as response } from "./response.js";

function harness(overrides = {}) {
  const events = [];
  const audits = [];
  const dispatched = [];
  const responseEndpoints = [];
  const notifications = [];
  const upserts = [];
  const capabilities = new Map([
    ["hello", { slug: "hello", name: "Hello", enabled: true, workflow: {} }],
    ["disabled", { slug: "disabled", name: "Disabled", enabled: false, workflow: {} }],
    ["admin-tool", { slug: "admin-tool", name: "Admin Tool", enabled: true, workflow: { adminOnly: true } }],
    ...(overrides.capabilities || []).map((capability) => [capability.slug, capability])
  ]);
  const handlers = createCapabilityHandlers({
    addRunEvent: (runId, type, message, detail) => events.push({ runId, type, message, detail }),
    createRunResponseEndpoint: (input) => {
      const stored = {
        id: `endpoint_${responseEndpoints.length + 1}`,
        type: input.type,
        config: input.config,
        runId: input.runId,
        createdBy: input.createdBy
      };
      responseEndpoints.push(stored);
      return stored;
    },
    dispatchRun: (capability, input, options) => {
      const run = { id: `run_${dispatched.length + 1}`, capabilitySlug: capability.slug, input, options };
      dispatched.push({ capability, input, options, run });
      return { run, supervising: overrides.supervising };
    },
    getCapability: (slug) => capabilities.get(slug) || null,
    listApprovals: () => overrides.pendingApprovals || [],
    listCapabilities: (options) => [{ slug: "hello", options }],
    listCapabilityVersionsFromRuns: (slug) => [`${slug}:v1`],
    notifyTelegram: async (approval) => { notifications.push(approval); },
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    root: overrides.root || process.cwd(),
    upsertCapability: (body) => {
      upserts.push(body);
      return { ...body, upserted: true };
    },
    withCapabilityLinks: (capability) => ({ ...capability, deepLink: `#/capabilities/${capability.slug}` }),
    withRunLinks: (run) => ({ ...run, deepLink: `#/runs/${run.id}` }),
    env: overrides.env || {}
  });
  return { audits, dispatched, events, handlers, notifications, responseEndpoints, upserts };
}

function bundleCapRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "runyard-bundle-cap-"));
  const workflows = path.join(root, "workflow-templates", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, "small.tsx"), "// smithers-display-name: Small\nexport default null;\n");
  writeFileSync(
    path.join(workflows, "huge.tsx"),
    `// smithers-display-name: Huge\n${"x".repeat(MAX_WORKFLOW_BUNDLE_BYTES + 1)}\n`
  );
  return root;
}

function req({ body = {}, params = {}, query = {}, scopes = ["api"], tokenName = "operator" } = {}) {
  return {
    body,
    params,
    query,
    headers: {},
    token: { id: "tok_1", name: tokenName, scopes }
  };
}

describe("capability route helpers", () => {
  it("lists, creates, updates, and versions capabilities", () => {
    const { handlers } = harness({ env: { RUNYARD_CAPABILITY_VERSIONING: "1" } });
    const listRes = response();
    handlers.listCapabilities(req({ query: { all: "1", q: "hel" }, scopes: ["admin"] }), listRes);
    assert.equal(listRes.body.capabilities[0].options.includeDisabled, true);
    assert.equal(listRes.body.capabilities[0].deepLink, "#/capabilities/hello");

    const createRes = response();
    handlers.createCapability(req({ body: { name: "My Capability" }, scopes: ["admin"] }), createRes);
    assert.equal(createRes.body.capability.slug, "my-capability");

    const updateRes = response();
    handlers.updateCapability(req({ params: { id: "hello" }, body: { name: "New" }, scopes: ["admin"] }), updateRes);
    assert.equal(updateRes.body.capability.slug, "hello");
    assert.equal(updateRes.body.capability.name, "New");

    const versionsRes = response();
    handlers.getCapabilityVersions(req({ params: { name: "hello" } }), versionsRes);
    assert.equal(versionsRes.body.versioningEnabled, true);
    assert.deepEqual(versionsRes.body.versions, ["hello:v1"]);
  });

  it("publishes capabilities whose workflow bundle is under the 500 KB cap", () => {
    const { handlers, upserts } = harness({ root: bundleCapRoot() });
    const res = response();
    handlers.createCapability(req({ body: { slug: "small", name: "Small" }, scopes: ["admin"] }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.capability.upserted, true);
    assert.equal(upserts.length, 1);
  });

  it("rejects oversized workflow bundles with 413 before anything is stored", () => {
    const { handlers, upserts } = harness({ root: bundleCapRoot() });
    const res = response();
    handlers.createCapability(req({ body: { slug: "huge", name: "Huge" }, scopes: ["admin"] }), res);

    assert.equal(res.statusCode, 413);
    assert.equal(upserts.length, 0);
    assert.ok(res.body.sizeBytes > MAX_WORKFLOW_BUNDLE_BYTES);
    assert.equal(res.body.maxWorkflowBundleBytes, MAX_WORKFLOW_BUNDLE_BYTES);
    assert.match(res.body.path, /huge\.tsx$/);
    assert.match(res.body.error, /500 KB/);
    assert.match(res.body.error, new RegExp(`is ${res.body.sizeBytes} bytes`));
    assert.match(res.body.error, /huge\.tsx/);
  });

  it("rejects updates that point an existing capability at an oversized workflow bundle", () => {
    const { handlers, upserts } = harness({ root: bundleCapRoot() });
    const res = response();
    handlers.updateCapability(req({
      params: { id: "hello" },
      body: { workflow: { entry: ".smithers/workflows/huge.tsx" } },
      scopes: ["admin"]
    }), res);

    assert.equal(res.statusCode, 413);
    assert.equal(upserts.length, 0);
    assert.match(res.body.error, /500 KB/);
  });

  it("returns the shared not-found response for missing and disabled run capabilities", async () => {
    const { dispatched, handlers } = harness();

    const missingRead = response();
    handlers.getCapability(req({ params: { id: "missing" } }), missingRead);
    assert.equal(missingRead.statusCode, 404);
    assert.equal(missingRead.body.error, "capability not found");

    const disabledRun = response();
    await handlers.runCapability(req({ params: { id: "disabled" } }), disabledRun);
    assert.equal(disabledRun.statusCode, 404);
    assert.equal(disabledRun.body.error, "capability not found");
    assert.equal(dispatched.length, 0);
  });

  it("returns metadata graph fallback when workflow source is unavailable", () => {
    const { handlers } = harness({
      capabilities: [{ slug: "metadata-only", name: "Metadata", enabled: true, workflow: { steps: [] } }]
    });
    const res = response();
    handlers.getCapabilitySource(req({ params: { id: "metadata-only" } }), res);

    assert.equal(res.body.available, false);
    assert.equal(res.body.capability.deepLink, "#/capabilities/metadata-only");
    assert.ok(res.body.graph);
  });

  it("rejects admin-only runs for non-admin tokens", async () => {
    const { dispatched, handlers } = harness();
    const res = response();
    await handlers.runCapability(req({ params: { id: "admin-tool" }, scopes: ["api"] }), res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "admin scope required");
    assert.equal(dispatched.length, 0);
  });

  it("dispatches runs with response endpoint registration, version options, and pending approval notification", async () => {
    const { audits, dispatched, events, handlers, notifications, responseEndpoints } = harness({
      env: { RUNYARD_CAPABILITY_VERSIONING: "1" },
      pendingApprovals: [{ id: "approval_1", runId: "run_1" }]
    });
    const res = response();
    await handlers.runCapability(req({
      params: { id: "hello" },
      body: {
        input: { goal: "run it" },
        chain: ["next"],
        executionMode: "local",
        pin: "abc123",
        parentRunId: "run_parent",
        responseEndpoint: { type: "http", config: { url: "https://example.test" } }
      },
      scopes: ["api", "admin"]
    }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(dispatched[0].capability.slug, "hello");
    assert.equal(dispatched[0].input.goal, "run it");
    assert.deepEqual(dispatched[0].input.__chain, [{ capability: "next", input: {} }]);
    assert.equal(dispatched[0].options.execution.mode, "local");
    assert.equal(dispatched[0].options.capabilitySha, "abc123");
    assert.equal(dispatched[0].options.parentRunId, "run_parent");
    assert.equal(responseEndpoints[0].runId, "run_1");
    assert.equal(events[0].type, "run.response_endpoint.registered");
    assert.equal(audits[0].action, "run.response_endpoint.registered");
    assert.deepEqual(notifications, [{ id: "approval_1", runId: "run_1" }]);
    assert.equal(res.body.responseEndpoint.id, "endpoint_1");
    assert.equal(res.body.deepLink, "/app#runs/run_1");
  });
});
