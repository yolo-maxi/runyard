import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apiVersionPayload,
  createPublicHandlers,
  healthPayload,
  publicUrl,
  versionPayload
} from "../src/publicRoutes.js";

function req({ protocol = "https", host = "hub.example", token = null } = {}) {
  return {
    protocol,
    token,
    get(name) {
      return name.toLowerCase() === "host" ? host : "";
    }
  };
}

function response() {
  return {
    body: null,
    file: null,
    redirectArgs: null,
    sent: null,
    statusCode: 200,
    typeValue: null,
    json(body) {
      this.body = body;
      return this;
    },
    redirect(...args) {
      this.redirectArgs = args;
      return this;
    },
    send(body) {
      this.sent = body;
      return this;
    },
    sendFile(file) {
      this.file = file;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.typeValue = value;
      return this;
    }
  };
}

function handlers(overrides = {}) {
  return createPublicHandlers({
    authFromRequest: (request) => request.token,
    dashboardStats: () => ({ ok: true }),
    env: {
      dataDir: "/tmp/runyard-data",
      instanceName: "Runyard",
      root: "/srv/runyard",
      version: "1.2.3"
    },
    getVersionInfo: () => ({ version: "1.2.3", gitTag: "v1.2.3", gitCommit: "abc123" }),
    listCapabilities: () => [{ id: "cap_1", slug: "demo", name: "Demo" }],
    runnerPoolStats: () => ({ idle: 1 }),
    startedAt: Date.now() - 2500,
    withCapabilityLinks: (capability) => ({ ...capability, links: { self: `/api/capabilities/${capability.id}` } }),
    ...overrides
  });
}

describe("public route helpers", () => {
  it("builds a request public URL", () => {
    assert.equal(publicUrl(req({ protocol: "http", host: "localhost:3000" })), "http://localhost:3000");
  });

  it("builds stable public metadata payloads", () => {
    assert.deepEqual(healthPayload(1_000, 3_500), { status: "ok", uptimeSeconds: 2 });
    assert.deepEqual(apiVersionPayload({ version: "1.2.3", instanceName: "Runyard" }), {
      name: "runyard",
      version: "1.2.3",
      instanceName: "Runyard"
    });
    assert.deepEqual(versionPayload({ version: "1.2.3", gitTag: "v1.2.3", gitCommit: "abc123" }), {
      version: "1.2.3",
      gitTag: "v1.2.3",
      gitCommit: "abc123"
    });
  });

  it("serves health, readiness, and version payloads", () => {
    const routeHandlers = handlers();
    const health = response();
    const ready = response();
    const apiVersion = response();
    const version = response();

    routeHandlers.healthz({}, health);
    routeHandlers.readyz({}, ready);
    routeHandlers.apiVersion({}, apiVersion);
    routeHandlers.version({}, version);

    assert.equal(health.body.status, "ok");
    assert.ok(health.body.uptimeSeconds >= 2);
    assert.deepEqual(ready.body, { status: "ready" });
    assert.deepEqual(apiVersion.body, { name: "runyard", version: "1.2.3", instanceName: "Runyard" });
    assert.deepEqual(version.body, { version: "1.2.3", gitTag: "v1.2.3", gitCommit: "abc123" });
  });

  it("reports readiness unavailable when the dashboard check fails", () => {
    const res = response();

    handlers({ dashboardStats: () => { throw new Error("db unavailable"); } }).readyz({}, res);

    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { status: "unavailable" });
  });

  it("redirects authenticated landing requests and serves static page files", () => {
    const routeHandlers = handlers();
    const anonymous = response();
    const authenticated = response();
    const app = response();
    const docs = response();

    routeHandlers.landing(req(), anonymous);
    routeHandlers.landing(req({ token: { id: "tok_1" } }), authenticated);
    routeHandlers.app({}, app);
    routeHandlers.docs({}, docs);

    assert.equal(anonymous.file, "/srv/runyard/public/landing.html");
    assert.deepEqual(authenticated.redirectArgs, [302, "/app"]);
    assert.equal(app.file, "/srv/runyard/public/index.html");
    assert.equal(docs.file, "/srv/runyard/public/docs.html");
  });

  it("renders install, llms, OpenAPI, and menu responses from shared base URL data", () => {
    const routeHandlers = handlers();
    const install = response();
    const llms = response();
    const openApi = response();
    const menu = response();
    const request = req({ protocol: "https", host: "hub.example" });

    routeHandlers.installScript(request, install);
    routeHandlers.llmsTxt(request, llms);
    routeHandlers.openApi(request, openApi);
    routeHandlers.menu(request, menu);

    assert.equal(install.typeValue, "text/plain");
    assert.match(install.sent, /https:\/\/hub\.example/);
    assert.equal(llms.typeValue, "text/plain");
    assert.match(llms.sent, /https:\/\/hub\.example\/api\/menu/);
    // llms.txt is unauthenticated: the live catalog must not leak into it.
    assert.doesNotMatch(llms.sent, /demo/);
    assert.doesNotMatch(llms.sent, /bootstrap-token/);
    assert.equal(openApi.body.info.version, "1.2.3");
    assert.equal(openApi.body.servers[0].url, "https://hub.example/api");
    assert.equal(menu.body.hub.status, "https://hub.example/api/runs/{runId}");
    assert.deepEqual(menu.body.pool, { idle: 1 });
    assert.equal(menu.body.capabilities[0].slug, "demo");
    assert.equal(menu.body.capabilities[0].runWithCli, "runyard run demo --where local --input '{\"title\":\"Short human-readable run title\"}'");
    assert.match(menu.body.runInputGuidance.title, /input\.title/);
  });
});
