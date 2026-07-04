import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHookProfileHandlers } from "../src/hookProfileRoutes.js";
import { createCapabilityHandlers } from "../src/capabilityRoutes.js";
import { mockResponse as response } from "./response.js";

function profile(overrides = {}) {
  return {
    id: "hook_1",
    slug: "static-publish",
    name: "Static publish",
    description: "Publish verified build output.",
    kind: "static-publish",
    config: { targetRoot: "/var/www/apps" },
    params: [{ name: "publicAccess", type: "boolean", description: "", required: false }],
    secretNames: [],
    allowedCapabilities: [],
    version: 1,
    enabled: true,
    ...overrides
  };
}

function harness({ profiles = [profile()], capabilities = {}, existingSecrets = [] } = {}) {
  const audits = [];
  const upserts = [];
  const byKey = new Map(profiles.flatMap((entry) => [[entry.slug, entry], [entry.id, entry]]));
  const handlers = createHookProfileHandlers({
    getCapability: (slug) => capabilities[slug] || null,
    getHookProfile: (slugOrId) => byKey.get(slugOrId) || null,
    listHookProfiles: ({ includeDisabled = false } = {}) =>
      profiles.filter((entry) => includeDisabled || entry.enabled),
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    secretExists: (name) => existingSecrets.includes(name),
    secretsEnabled: () => true,
    upsertHookProfile: (input) => {
      upserts.push(input);
      if (!input.kind) return { ok: false, errors: ["kind must be one of: static-publish, ..."] };
      return { ok: true, hookProfile: profile({ slug: input.slug, kind: input.kind, version: 2 }) };
    }
  });
  return { audits, handlers, upserts };
}

function req({ body = {}, params = {}, query = {}, scopes = ["api"] } = {}) {
  return { body, params, query, headers: {}, token: { id: "tok_1", name: "operator", scopes } };
}

describe("hook profile routes", () => {
  it("shows non-admin callers only enabled profiles in the caller-safe shape", () => {
    const { handlers } = harness({
      profiles: [profile(), profile({ id: "hook_2", slug: "git-push-work", enabled: false })]
    });
    const res = response();
    handlers.listHookProfiles(req(), res);
    assert.equal(res.body.hookProfiles.length, 1);
    const [presented] = res.body.hookProfiles;
    assert.equal(presented.slug, "static-publish");
    assert.equal(presented.config, undefined);
    assert.equal(presented.secretNames, undefined);
    assert.equal(presented.readiness, undefined);
    assert.equal(JSON.stringify(res.body).includes("/var/www"), false);
  });

  it("shows admins everything with readiness, including disabled profiles via ?all=1", () => {
    const { handlers } = harness({
      profiles: [profile({ secretNames: ["DEPLOY_KEY"] }), profile({ id: "hook_2", slug: "old-hook", enabled: false })]
    });
    const res = response();
    handlers.listHookProfiles(req({ query: { all: "1" }, scopes: ["admin"] }), res);
    assert.equal(res.body.hookProfiles.length, 2);
    assert.equal(res.body.hookProfiles[0].readiness.status, "hook_config_required");
    assert.deepEqual(res.body.hookProfiles[0].readiness.missingSecrets, ["DEPLOY_KEY"]);

    // Non-admins cannot use all=1 to see disabled profiles.
    const sneaky = response();
    handlers.listHookProfiles(req({ query: { all: "1" } }), sneaky);
    assert.equal(sneaky.body.hookProfiles.length, 1);
  });

  it("filters discovery to profiles the capability may select", () => {
    const capability = {
      slug: "idea-to-product",
      workflow: { hooks: { allowedProfiles: ["static-publish"] } }
    };
    const { handlers } = harness({
      profiles: [profile(), profile({ id: "hook_2", slug: "git-push-work" })],
      capabilities: { "idea-to-product": capability }
    });
    const res = response();
    handlers.listHookProfiles(req({ query: { capability: "idea-to-product" } }), res);
    assert.deepEqual(res.body.hookProfiles.map((entry) => entry.slug), ["static-publish"]);

    const missing = response();
    handlers.listHookProfiles(req({ query: { capability: "ghost" } }), missing);
    assert.equal(missing.statusCode, 404);
  });

  it("hides disabled profiles from non-admin describe", () => {
    const { handlers } = harness({ profiles: [profile({ enabled: false })] });
    const nonAdmin = response();
    handlers.getHookProfile(req({ params: { slug: "static-publish" } }), nonAdmin);
    assert.equal(nonAdmin.statusCode, 404);

    const admin = response();
    handlers.getHookProfile(req({ params: { slug: "static-publish" }, scopes: ["admin"] }), admin);
    assert.equal(admin.statusCode, 200);
    assert.equal(admin.body.hookProfile.enabled, false);
    assert.ok(admin.body.hookProfile.readiness);
  });

  it("rejects invalid upserts with 400 and records slug-only audit entries on success", () => {
    const { audits, handlers } = harness();
    const bad = response();
    handlers.upsertHookProfile(req({ body: { slug: "broken" }, scopes: ["admin"] }), bad);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.error, "invalid hook profile");
    assert.equal(audits.length, 0, "invalid definitions are not audited as changes");

    const good = response();
    handlers.upsertHookProfile(req({ body: { slug: "static-publish", kind: "static-publish" }, scopes: ["admin"] }), good);
    assert.equal(good.statusCode, 200);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "hook_profile.upserted");
    assert.equal(audits[0].target, "static-publish");
    // Audit detail carries identifiers only — never config or secrets.
    assert.deepEqual(Object.keys(audits[0].detail).sort(), ["enabled", "kind", "slug", "version"]);
  });

  it("validates readiness with missing secret names only", () => {
    const { handlers } = harness({
      profiles: [profile({ secretNames: ["WEBHOOK_TOKEN", "PRESENT_TOKEN"] })],
      existingSecrets: ["PRESENT_TOKEN"]
    });
    const res = response();
    handlers.validateHookProfile(req({ params: { slug: "static-publish" }, scopes: ["admin"] }), res);
    assert.equal(res.body.ready, false);
    assert.equal(res.body.status, "hook_config_required");
    assert.deepEqual(res.body.missingSecrets, ["WEBHOOK_TOKEN"]);
  });
});

describe("post-run hook selection at dispatch", () => {
  function dispatchHarness({ profiles }) {
    const dispatched = [];
    const capability = {
      slug: "idea-to-product",
      name: "Idea to Product",
      enabled: true,
      workflow: { hooks: { allowedProfiles: ["static-publish"] } }
    };
    const handlers = createCapabilityHandlers({
      addRunEvent: () => {},
      createRunResponseEndpoint: () => null,
      dispatchRun: (cap, input, options) => {
        const run = { id: `run_${dispatched.length + 1}`, capabilitySlug: cap.slug, input, options };
        dispatched.push(run);
        return { run };
      },
      getCapability: (slug) => (slug === capability.slug ? capability : null),
      getWorkflowBundle: () => null,
      listApprovals: () => [],
      listCapabilities: () => [],
      listCapabilityVersionsFromRuns: () => [],
      listHookProfiles: () => profiles,
      notifyTelegram: async () => {},
      recordAudit: () => {},
      root: process.cwd(),
      upsertCapability: (body) => body,
      withCapabilityLinks: (cap) => cap,
      withRunLinks: (run) => run,
      env: {}
    });
    return { dispatched, handlers };
  }

  it("dispatches runs whose postRunHooks selection is enabled and allowed", async () => {
    const { dispatched, handlers } = dispatchHarness({ profiles: [profile()] });
    const res = response();
    await handlers.runCapability(req({
      params: { id: "idea-to-product" },
      body: { input: { idea: "an app", postRunHooks: ["static-publish"] } }
    }), res);
    assert.equal(res.statusCode, 202);
    assert.equal(dispatched.length, 1);
  });

  it("rejects ineligible hook selections before a run is created", async () => {
    // Profile exists but is disabled: hook_blocked, nothing dispatched.
    const { dispatched, handlers } = dispatchHarness({ profiles: [profile({ enabled: false })] });
    const res = response();
    await handlers.runCapability(req({
      params: { id: "idea-to-product" },
      body: { input: { idea: "an app", postRunHooks: ["static-publish"] } }
    }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "hook_blocked");
    assert.deepEqual(res.body.blocked, ["static-publish"]);
    assert.equal(dispatched.length, 0);

    // Profile the capability never opted into: also blocked.
    const other = dispatchHarness({ profiles: [profile({ slug: "git-push-work", id: "hook_9" })] });
    const otherRes = response();
    await other.handlers.runCapability(req({
      params: { id: "idea-to-product" },
      body: { input: { idea: "an app", postRunHooks: ["git-push-work"] } }
    }), otherRes);
    assert.equal(otherRes.statusCode, 400);
    assert.equal(other.dispatched.length, 0);
  });
});
