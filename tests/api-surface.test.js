import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// serverRoutes.js transitively imports db.js, which opens the configured
// SQLite at import time — point it at a throwaway dir before importing so the
// test never touches (or races) a live deployment's database.
const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-api-surface-"));
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token";

const {
  API_SURFACE,
  mcpExemptOperations,
  mcpToolCoverage,
  openApiPathsFromSurface
} = await import("../src/apiSurface.js");
const { openApiDocument, hubMenuPayload } = await import("../src/discoveryDocs.js");
const { MCP_TOOLS } = await import("../src/mcpTools.js");
const { registerServerRoutes } = await import("../src/serverRoutes.js");

// These tests are the drift guards behind the API-first invariant
// (docs/api-surface-parity-audit.md): the web UI is an ordinary API client,
// every API operation is either exposed over MCP or carries a written
// exemption, and the OpenAPI document always describes the real route table.

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("api surface registry", () => {
  it("has unique method+path entries with summaries and known scopes", () => {
    const seen = new Set();
    const knownScopes = new Set(["api", "mcp", "runner", "admin", "approvals"]);
    for (const operation of API_SURFACE) {
      const key = `${operation.method} ${operation.path}`;
      assert.ok(!seen.has(key), `duplicate registry entry ${key}`);
      seen.add(key);
      assert.ok(operation.summary?.length > 3, `${key} needs a summary`);
      for (const scope of operation.scopes || []) {
        assert.ok(knownScopes.has(scope), `${key} uses unknown scope ${scope}`);
      }
      if (operation.scopes?.length) {
        assert.equal(operation.auth, true, `${key} declares scopes but not auth`);
      }
    }
  });

  it("registers exactly the routes the registry declares, with the declared middleware", () => {
    const app = mockApp();
    const deps = routeDeps();
    registerServerRoutes(app, deps);

    const registered = new Map(app.calls.map((call) => [`${call.method} ${call.path}`, call]));
    const expected = new Map(API_SURFACE.map((operation) => [
      `${operation.method === "static" ? "use" : operation.method} ${operation.path}`,
      operation
    ]));

    for (const key of expected.keys()) {
      assert.ok(registered.has(key), `registry operation ${key} was not registered`);
    }
    for (const key of registered.keys()) {
      assert.ok(expected.has(key), `route ${key} is registered but missing from src/apiSurface.js`);
    }

    for (const [key, operation] of expected) {
      if (operation.external || operation.method === "static") continue;
      const call = registered.get(key);
      const chain = [];
      if (operation.auth) chain.push(deps.requireAuth);
      if (operation.scopes?.length) chain.push(deps.scopes[operation.scopes.join(",")]);
      if (operation.runnerOwner) chain.push(deps.requireRunOwnerOrAdmin);
      if (operation.secretsGate) chain.push(deps.secretHandlers.requireSecretsEnabled);
      if (operation.rateLimit) chain.push(deps.rateLimits[operation.rateLimit.bucket]);
      assert.equal(call.handlers.length, chain.length + 1, `${key} middleware chain length`);
      chain.forEach((middleware, index) => {
        assert.equal(call.handlers[index], middleware, `${key} middleware ${index}`);
      });
      const terminal = call.handlers[chain.length];
      if (operation.wrap === "async") {
        assert.equal(typeof terminal, "function", `${key} async-wrapped handler`);
      } else {
        assert.equal(terminal, resolveDep(deps, operation.handler), `${key} handler`);
      }
    }
  });
});

describe("api surface <-> mcp parity", () => {
  const toolNames = new Set(MCP_TOOLS.map((tool) => tool.name));

  it("exposes every non-exempt API operation as an MCP tool", () => {
    for (const [tool, operations] of mcpToolCoverage()) {
      assert.ok(toolNames.has(tool), `registry expects MCP tool ${tool} (covers ${operations.join(", ")}) but src/mcpTools.js does not define it`);
    }
  });

  it("requires a written exemption for every API operation without an MCP tool", () => {
    for (const operation of mcpExemptOperations()) {
      assert.ok(
        typeof operation.mcpExempt === "string" && operation.mcpExempt.length > 10,
        `${operation.method.toUpperCase()} ${operation.path} has no MCP tool and no mcpExempt reason`
      );
    }
  });

  it("maps every MCP tool back to at least one API operation", () => {
    const coverage = mcpToolCoverage();
    for (const tool of toolNames) {
      assert.ok(coverage.has(tool), `MCP tool ${tool} does not cover any operation in src/apiSurface.js`);
    }
  });

  it("dispatches every advertised MCP tool in mcp.js", () => {
    const source = readFileSync(path.join(repoRoot, "src/mcp.js"), "utf8");
    for (const tool of toolNames) {
      assert.ok(source.includes(`"${tool}"`), `mcp.js callTool has no branch for ${tool}`);
    }
  });

  it("advertises only real tools in the menu payload and llms.txt", () => {
    const menu = hubMenuPayload({ baseUrl: "https://hub.example" });
    for (const tool of menu.tools) {
      assert.ok(toolNames.has(tool), `menu/llms.txt advertises unknown tool ${tool}`);
    }
  });
});

describe("api surface <-> openapi parity", () => {
  it("documents every /api operation in openapi.json", () => {
    const doc = openApiDocument({ baseUrl: "https://hub.example", version: "0.0.0" });
    assert.deepEqual(doc.paths, openApiPathsFromSurface());
    for (const operation of API_SURFACE) {
      if (operation.openApi === false || !operation.path.startsWith("/api/")) continue;
      const openApiPath = operation.path.slice("/api".length).replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
      assert.ok(doc.paths[openApiPath]?.[operation.method], `openapi.json is missing ${operation.method.toUpperCase()} ${openApiPath}`);
    }
  });
});

describe("web app is an ordinary api client", () => {
  it("only calls endpoints that exist in the api surface registry", () => {
    const violations = [];
    for (const file of walk(path.join(repoRoot, "web"))) {
      if (!/\.(js|jsx)$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\/api\/[A-Za-z0-9\-_/${}]*/g)) {
        const literal = match[0];
        const prefix = literal.split("${")[0].split("?")[0].replace(/\/$/, "");
        if (prefix === "/api" || prefix === "") continue;
        if (!prefixMatchesSurface(prefix)) {
          violations.push(`${path.relative(repoRoot, file)}: ${literal}`);
        }
      }
    }
    assert.deepEqual(violations, [], `web/ calls endpoints missing from src/apiSurface.js:\n${violations.join("\n")}`);
  });
});

function prefixMatchesSurface(prefix) {
  const prefixSegments = prefix.split("/").filter(Boolean);
  return API_SURFACE.some((operation) => {
    const routeSegments = operation.path.split("/").filter(Boolean);
    if (routeSegments.length < prefixSegments.length) return false;
    return prefixSegments.every((segment, index) =>
      routeSegments[index].startsWith(":") || routeSegments[index] === segment
    );
  });
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function resolveDep(deps, handlerPath) {
  let value = deps;
  for (const segment of handlerPath.split(".")) value = value[segment];
  return value;
}

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
    runLifecycleHandlers: handlers(["recordRunEvent", "startRun", "completeRun", "failRun", "cancelRun"]),
    runPromotionHandlers: handlers(["promoteRun"]),
    runReadHandlers: handlers(["listRuns", "getRun", "listRunEvents", "streamRunEvents", "getRunLogSummary", "getRunDiagnostics", "getRunLogs", "getRunTimeline"]),
    runRerunHandlers: handlers(["rerunRun"]),
    scheduleHandlers: handlers(["listSchedules", "previewSchedule", "getSchedule", "createSchedule", "updateSchedule", "enableSchedule", "disableSchedule", "deleteSchedule", "runScheduleNowRoute"]),
    secretHandlers: handlers(["requireSecretsEnabled", "listSecrets", "upsertSecret", "deleteSecret"]),
    supportChatHandlers: handlers(["status", "chat"]),
    tokenHandlers: handlers(["listTokens", "createToken", "revokeToken"]),
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
