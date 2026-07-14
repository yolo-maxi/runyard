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
  API_GROUPS,
  API_SURFACE,
  apiV1AliasOperations,
  fullApiSurface,
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
  it("has unique method+path entries with summaries and known scopes, including v1 aliases", () => {
    const seen = new Set();
    const knownScopes = new Set(["api", "mcp", "runner", "admin", "approvals", "read"]);
    for (const operation of fullApiSurface()) {
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

  it("assigns every entry to a known API group", () => {
    for (const operation of API_SURFACE) {
      assert.ok(
        API_GROUPS[operation.group],
        `${operation.method} ${operation.path} needs a group from API_GROUPS (got ${operation.group})`
      );
    }
  });

  it("derives v1 aliases that share the canonical operation's contract", () => {
    const aliases = apiV1AliasOperations();
    assert.ok(aliases.length >= 60, `expected a substantial v1 alias surface, got ${aliases.length}`);
    const canonical = new Map(API_SURFACE.map((operation) => [`${operation.method} ${operation.path}`, operation]));
    for (const alias of aliases) {
      assert.ok(alias.path.startsWith("/api/v1/"), `${alias.path} must live under /api/v1/`);
      const source = canonical.get(`${alias.method} ${alias.aliasFor}`);
      assert.ok(source, `alias ${alias.method} ${alias.path} points at unknown canonical ${alias.aliasFor}`);
      assert.equal(alias.handler, source.handler, `${alias.path} handler drifted`);
      assert.deepEqual(alias.scopes, source.scopes, `${alias.path} scopes drifted`);
      assert.equal(alias.auth, source.auth, `${alias.path} auth drifted`);
      assert.ok(!source.deprecated, `${alias.path} must not alias the deprecated ${alias.aliasFor}`);
      assert.ok(!source.external, `${alias.path} cannot alias externally registered ${alias.aliasFor}`);
      assert.ok(!alias.mcp, `${alias.path} must not add MCP tools`);
      assert.ok(alias.mcpExempt.length > 10, `${alias.path} needs an mcpExempt reason`);
    }
    // Legacy capability paths, runner machine-protocol operations, and
    // externally registered routes stay unversioned.
    for (const operation of API_SURFACE) {
      if (operation.deprecated || operation.external || operation.runnerOwner) {
        assert.ok(!operation.v1Path, `${operation.method} ${operation.path} must not declare v1Path`);
      }
    }
  });

  it("registers exactly the routes the registry declares, with the declared middleware", () => {
    const app = mockApp();
    const deps = routeDeps();
    registerServerRoutes(app, deps);

    const registered = new Map(app.calls.map((call) => [`${call.method} ${call.path}`, call]));
    const expected = new Map(fullApiSurface().map((operation) => [
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

  it("registers each v1 alias with exactly the canonical route's middleware chain", () => {
    const app = mockApp();
    const deps = routeDeps();
    registerServerRoutes(app, deps);
    const byKey = new Map(app.calls.map((call) => [`${call.method} ${call.path}`, call]));
    for (const alias of apiV1AliasOperations()) {
      const aliasCall = byKey.get(`${alias.method} ${alias.path}`);
      const canonicalCall = byKey.get(`${alias.method} ${alias.aliasFor}`);
      assert.ok(aliasCall, `alias ${alias.method} ${alias.path} was not registered`);
      assert.ok(canonicalCall, `canonical ${alias.method} ${alias.aliasFor} was not registered`);
      assert.equal(aliasCall.handlers.length, canonicalCall.handlers.length, `${alias.path} chain length differs from ${alias.aliasFor}`);
      aliasCall.handlers.forEach((middleware, index) => {
        if (index === aliasCall.handlers.length - 1 && alias.wrap === "async") {
          assert.equal(typeof middleware, "function", `${alias.path} async-wrapped handler`);
          return;
        }
        assert.equal(middleware, canonicalCall.handlers[index], `${alias.path} middleware ${index} drifted from ${alias.aliasFor}`);
      });
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
    for (const operation of fullApiSurface()) {
      if (operation.openApi === false || !operation.path.startsWith("/api/")) continue;
      const openApiPath = operation.path.slice("/api".length).replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
      assert.ok(doc.paths[openApiPath]?.[operation.method], `openapi.json is missing ${operation.method.toUpperCase()} ${openApiPath}`);
    }
  });

  it("tags every operation with its API group and lists the groups as document tags", () => {
    const doc = openApiDocument({ baseUrl: "https://hub.example", version: "0.0.0" });
    const documentTags = new Set((doc.tags || []).map((tag) => tag.name));
    assert.deepEqual([...documentTags].sort(), Object.keys(API_GROUPS).sort());
    for (const [pathKey, methods] of Object.entries(doc.paths)) {
      for (const [method, entry] of Object.entries(methods)) {
        assert.ok(Array.isArray(entry.tags) && entry.tags.length === 1, `${method.toUpperCase()} ${pathKey} needs exactly one tag`);
        assert.ok(documentTags.has(entry.tags[0]), `${method.toUpperCase()} ${pathKey} uses undeclared tag ${entry.tags[0]}`);
      }
    }
    // Alias paths advertise their canonical unversioned path.
    assert.equal(doc.paths["/v1/automation/schedules"].get["x-canonical-path"], "/schedules");
    assert.equal(doc.paths["/v1/runs/{id}"].get["x-canonical-path"], "/runs/{id}");
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
    gatewayHandlers: handlers(["openAiChatCompletions", "anthropicMessages"]),
    runLifecycleHandlers: handlers(["recordRunEvent", "recordRunUsage", "startRun", "completeRun", "failRun", "cancelRun", "pauseRun", "resumeRun"]),
    runPromotionHandlers: handlers(["promoteRun"]),
    runReadHandlers: handlers(["listRuns", "listAttentionRuns", "getUsageSummary", "getRun", "listRunEvents", "streamRunEvents", "getRunLogSummary", "getRunDiagnostics", "getRunLogs", "getRunTimeline", "getRunUsage"]),
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
