import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerServerRoutes } from "../src/serverRoutes.js";

describe("server route registration", () => {
  it("registers public, protected, runner, and support routes with expected middleware", () => {
    const app = mockApp();
    const deps = routeDeps();

    registerServerRoutes(app, deps);

    assert.ok(app.calls.length > 60);
    assertRoute(app, "get", "/healthz", [deps.publicHandlers.healthz]);
    assertRoute(app, "get", "/api/menu", [deps.requireAuth, deps.scopes["api,mcp,read"], deps.publicHandlers.menu]);
    assertRoute(app, "post", "/api/auth/token-login", [deps.rateLimits.login, deps.authHandlers.tokenLogin]);
    assertRoute(app, "post", "/api/runs/:id/complete", [
      deps.requireAuth,
      deps.scopes.runner,
      deps.requireRunOwnerOrAdmin,
      deps.runLifecycleHandlers.completeRun
    ]);
    assertRoute(app, "post", "/api/runs/:id/promote", [
      deps.requireAuth,
      deps.scopes["api,mcp"]
    ]);
    assertRoute(app, "post", "/api/workflow-bundles", [deps.requireAuth, deps.scopes.admin, deps.workflowBundleHandlers.publishWorkflowBundle]);
    // Hook profiles: discovery is authenticated; mutations + readiness are admin-only.
    assertRoute(app, "get", "/api/hooks", [deps.requireAuth, deps.hookProfileHandlers.listHookProfiles]);
    assertRoute(app, "get", "/api/hooks/:slug", [deps.requireAuth, deps.hookProfileHandlers.getHookProfile]);
    assertRoute(app, "post", "/api/hooks", [deps.requireAuth, deps.scopes.admin, deps.hookProfileHandlers.upsertHookProfile]);
    assertRoute(app, "patch", "/api/hooks/:slug", [deps.requireAuth, deps.scopes.admin, deps.hookProfileHandlers.upsertHookProfile]);
    assertRoute(app, "post", "/api/hooks/:slug/validate", [deps.requireAuth, deps.scopes.admin, deps.hookProfileHandlers.validateHookProfile]);
    assertRoute(app, "get", "/api/workflow-bundles/:id", [deps.requireAuth, deps.workflowBundleHandlers.getWorkflowBundle]);
    assertRoute(app, "get", "/api/workflow-packages/workflows/:id/export", [deps.requireAuth, deps.scopes.admin, deps.workflowPackageHandlers.exportWorkflowPackage]);
    assertRoute(app, "get", "/api/workflow-packages/capabilities/:id/export", [deps.requireAuth, deps.scopes.admin, deps.workflowPackageHandlers.exportWorkflowPackage]);
    assertRoute(app, "post", "/api/workflow-packages/validate", [deps.requireAuth, deps.scopes.admin, deps.workflowPackageHandlers.validateWorkflowPackage]);
    assertRoute(app, "post", "/api/workflow-packages/preview", [deps.requireAuth, deps.scopes.admin, deps.workflowPackageHandlers.previewWorkflowPackageImport]);
    assertRoute(app, "post", "/api/workflow-packages/import", [deps.requireAuth, deps.scopes.admin, deps.workflowPackageHandlers.importWorkflowPackage]);
    assertRoute(app, "get", "/api/workflows", [deps.requireAuth, deps.capabilityHandlers.listWorkflows]);
    assertRoute(app, "post", "/api/workflows", [deps.requireAuth, deps.scopes.admin, deps.capabilityHandlers.createWorkflow]);
    assertRoute(app, "patch", "/api/workflows/:id", [deps.requireAuth, deps.scopes.admin, deps.capabilityHandlers.updateWorkflow]);
    assertRoute(app, "delete", "/api/workflows/:id", [deps.requireAuth, deps.scopes.admin, deps.capabilityHandlers.deleteWorkflow]);
    assertRoute(app, "post", "/api/workflows/:id/preflight", [deps.requireAuth, deps.scopes["api,mcp"], deps.capabilityHandlers.preflightWorkflow]);
    // Run drafts: reads are any-auth; mutations carry the same api/mcp scopes as starting a run.
    assertRoute(app, "get", "/api/run-drafts", [deps.requireAuth, deps.runDraftHandlers.listRunDrafts]);
    assertRoute(app, "post", "/api/run-drafts", [deps.requireAuth, deps.scopes["api,mcp"], deps.runDraftHandlers.createRunDraft]);
    assertRoute(app, "get", "/api/run-drafts/:id", [deps.requireAuth, deps.runDraftHandlers.getRunDraft]);
    assertRoute(app, "patch", "/api/run-drafts/:id", [deps.requireAuth, deps.scopes["api,mcp"], deps.runDraftHandlers.patchRunDraft]);
    assertRoute(app, "post", "/api/run-drafts/:id/submit", [deps.requireAuth, deps.scopes["api,mcp"]]);
    assertRoute(app, "post", "/api/run-drafts/:id/discard", [deps.requireAuth, deps.scopes["api,mcp"], deps.runDraftHandlers.discardRunDraft]);
    assertRoute(app, "post", "/api/runners/register", [deps.requireAuth, deps.scopes.runner]);
    assertRoute(app, "post", "/api/chat", [deps.requireAuth, deps.rateLimits["support-chat"]]);
    assertRoute(app, "use", "/public");
    // Grouped /api/v1 aliases share the canonical middleware and handlers.
    assertRoute(app, "get", "/api/v1/admin/tokens/scopes", [deps.requireAuth, deps.scopes.admin, deps.tokenHandlers.listTokenScopes]);
    assertRoute(app, "get", "/api/v1/automation/schedules", [deps.requireAuth, deps.scheduleHandlers.listSchedules]);
    assertRoute(app, "post", "/api/v1/workflows/:id/preflight", [deps.requireAuth, deps.scopes["api,mcp"], deps.capabilityHandlers.preflightWorkflow]);
    assertRoute(app, "get", "/api/v1/runs/drafts", [deps.requireAuth, deps.runDraftHandlers.listRunDrafts]);
    assertRoute(app, "get", "/api/v1/system/menu", [deps.requireAuth, deps.scopes["api,mcp,read"], deps.publicHandlers.menu]);
  });
});

function routeDeps() {
  const deps = {
    requireAuth: marker("requireAuth"),
    requireRunOwnerOrAdmin: marker("requireRunOwnerOrAdmin"),
    scopes: {},
    rateLimits: {}
  };
  deps.requireScopes = (...scopes) => {
    const key = scopes.join(",");
    deps.scopes[key] ||= marker(`scope:${key}`);
    return deps.scopes[key];
  };
  deps.rateLimit = ({ bucket }) => {
    deps.rateLimits[bucket] ||= marker(`rate:${bucket}`);
    return deps.rateLimits[bucket];
  };
  return {
    ...deps,
    adminReadHandlers: handlers(["listAudit", "listAlerts"]),
    approvalHandlers: handlers(["listApprovals", "getApproval", "createApproval", "approve", "reject", "requestChanges", "telegramWebhook"]),
    artifactHandlers: handlers(["listRunArtifacts", "createRunArtifact", "listArtifacts", "downloadArtifact"]),
    authHandlers: handlers(["setup", "tokenLogin", "telegramWebAppLogin", "logout", "me"]),
    capabilityHandlers: handlers([
      "listCapabilities",
      "createCapability",
      "getCapability",
      "getCapabilityVersions",
      "getCapabilitySource",
      "updateCapability",
      "runCapability",
      "preflightCapability",
      "listWorkflows",
      "createWorkflow",
      "getWorkflow",
      "getWorkflowVersions",
      "getWorkflowSource",
      "updateWorkflow",
      "deleteWorkflow",
      "runWorkflow",
      "preflightWorkflow"
    ]),
    catalogHandlers: {
      agents: handlers(["list", "create", "update"], "agents"),
      skills: handlers(["list", "create", "update"], "skills"),
      knowledge: handlers(["list", "create", "update"], "knowledge")
    },
    hookProfileHandlers: handlers(["listHookProfiles", "getHookProfile", "upsertHookProfile", "validateHookProfile"]),
    operatorReadHandlers: handlers(["dashboard", "repoOptions"]),
    publicHandlers: {
      ...handlers(["healthz", "readyz", "apiVersion", "version", "cliTarball", "installScript", "landing", "app", "docsSite", "llmsTxt", "openApi", "menu"]),
      publicDir: "/tmp/runyard-public"
    },
    runDraftHandlers: handlers(["listRunDrafts", "createRunDraft", "getRunDraft", "patchRunDraft", "submitRunDraft", "discardRunDraft"]),
    gatewayHandlers: handlers(["openAiChatCompletions", "anthropicMessages"]),
    runLifecycleHandlers: handlers(["recordRunEvent", "recordRunUsage", "startRun", "completeRun", "failRun", "cancelRun", "pauseRun", "resumeRun"]),
    runPromotionHandlers: handlers(["promoteRun"]),
    runReadHandlers: handlers(["listRuns", "getRun", "listRunEvents", "streamRunEvents", "getRunLogSummary", "getRunDiagnostics", "getRunLogs", "getRunTimeline", "getRunUsage"]),
    runRerunHandlers: handlers(["rerunRun"]),
    scheduleHandlers: handlers(["listSchedules", "previewSchedule", "getSchedule", "createSchedule", "updateSchedule", "enableSchedule", "disableSchedule", "deleteSchedule", "runScheduleNowRoute"]),
    secretHandlers: handlers(["requireSecretsEnabled", "listSecrets", "upsertSecret", "deleteSecret"]),
    supportChatHandlers: handlers(["status", "chat"]),
    tokenHandlers: handlers(["listTokens", "listTokenScopes", "createToken", "revokeToken"]),
    updateHandlers: handlers(["status", "apply"]),
    workflowBundleHandlers: handlers(["listWorkflowBundles", "publishWorkflowBundle", "getWorkflowBundle"]),
    workflowPackageHandlers: handlers(["exportWorkflowPackage", "validateWorkflowPackage", "previewWorkflowPackageImport", "importWorkflowPackage"]),
    workflowEndpointHandlers: handlers(["listWorkflowEndpoints", "upsertWorkflowEndpoint", "getWorkflowEndpoint", "submitWorkflowEndpoint"])
  };
}

function handlers(names, prefix = "") {
  return Object.fromEntries(names.map((name) => [name, marker(prefix ? `${prefix}.${name}` : name)]));
}

function marker(name) {
  return Object.assign(() => {}, { marker: name });
}

function mockApp() {
  const calls = [];
  const record = (method) => (...args) => {
    calls.push({ method, path: args[0], handlers: args.slice(1) });
  };
  return {
    calls,
    delete: record("delete"),
    get: record("get"),
    patch: record("patch"),
    post: record("post"),
    put: record("put"),
    use: record("use")
  };
}

function assertRoute(app, method, path, expectedPrefix = []) {
  const route = app.calls.find((call) => call.method === method && call.path === path);
  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
  for (let i = 0; i < expectedPrefix.length; i += 1) {
    assert.equal(route.handlers[i], expectedPrefix[i]);
  }
}
