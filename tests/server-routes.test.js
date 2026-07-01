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
    assertRoute(app, "get", "/api/menu", [deps.requireAuth, deps.scopes["api,mcp"], deps.publicHandlers.menu]);
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
    assertRoute(app, "post", "/api/runners/register", [deps.requireAuth, deps.scopes.runner]);
    assertRoute(app, "post", "/api/chat", [deps.requireAuth, deps.rateLimits["support-chat"]]);
    assertRoute(app, "use", "/public");
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
    capabilityHandlers: handlers(["listCapabilities", "createCapability", "getCapability", "getCapabilityVersions", "getCapabilitySource", "updateCapability", "runCapability"]),
    catalogHandlers: {
      agents: handlers(["list", "create", "update"], "agents"),
      skills: handlers(["list", "create", "update"], "skills"),
      knowledge: handlers(["list", "create", "update"], "knowledge")
    },
    operatorReadHandlers: handlers(["dashboard", "repoOptions"]),
    publicHandlers: {
      ...handlers(["healthz", "readyz", "apiVersion", "version", "cliTarball", "installScript", "landing", "app", "docs", "llmsTxt", "openApi", "menu"]),
      publicDir: "/tmp/runyard-public"
    },
    runLifecycleHandlers: handlers(["recordRunEvent", "startRun", "completeRun", "failRun", "cancelRun"]),
    runPromotionHandlers: handlers(["promoteRun"]),
    runReadHandlers: handlers(["listRuns", "getRun", "listRunEvents", "streamRunEvents", "getRunLogSummary", "getRunDiagnostics", "getRunLogs", "getRunTimeline"]),
    runRerunHandlers: handlers(["rerunRun"]),
    scheduleHandlers: handlers(["listSchedules", "previewSchedule", "getSchedule", "createSchedule", "updateSchedule", "enableSchedule", "disableSchedule", "deleteSchedule", "runScheduleNowRoute"]),
    secretHandlers: handlers(["requireSecretsEnabled", "listSecrets", "upsertSecret", "deleteSecret"]),
    supportChatHandlers: handlers(["status", "chat"]),
    tokenHandlers: handlers(["listTokens", "createToken", "revokeToken"]),
    updateHandlers: handlers(["status", "apply"]),
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
