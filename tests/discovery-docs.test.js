import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hubMenuPayload,
  openApiDocument,
  renderLlmsTxt
} from "../src/discoveryDocs.js";

describe("discovery docs", () => {
  it("builds a menu payload with runnable capability examples", () => {
    const menu = hubMenuPayload({
      baseUrl: "https://hub.example",
      pool: { online: 1 },
      capabilities: [{
        slug: "hello",
        name: "Hello",
        description: "Says hi",
        category: "starter",
        requiredRunnerTags: ["smithers"],
        deepLink: "/app#workflows/hello"
      }]
    });

    assert.equal(menu.hub.status, "https://hub.example/api/runs/{runId}");
    assert.equal(menu.capabilities[0].runWithCli, "runyard run hello --where local --input '{\"title\":\"Short human-readable run title\"}'");
    assert.deepEqual(menu.capabilities[0].runWithMcp, {
      tool: "run_capability",
      arguments: { id: "hello", input: { title: "Short human-readable run title" }, executionMode: "local" }
    });
    assert.match(menu.runInputGuidance.title, /input\.title/);
    assert.equal(menu.pool.online, 1);
  });

  it("renders a static llms.txt that points agents at the authenticated menu", () => {
    const text = renderLlmsTxt("https://hub.example");

    assert.match(text, /^# Runyard \(codebase: runyard\)/);
    assert.match(text, /- OpenAPI: https:\/\/hub\.example\/openapi\.json/);
    assert.match(text, /Menu \(authenticated\): https:\/\/hub\.example\/api\/menu/);
    assert.match(text, /- local -> runners tagged local/);
    assert.match(text, /For agent-created runs, include input\.title/);
    assert.match(text, /- get_menu/);
    assert.ok(text.endsWith("\n"));
  });

  it("keeps deployment-private details out of the unauthenticated llms.txt", () => {
    const text = renderLlmsTxt("https://hub.example");

    // The live capability catalog is private per-deployment: authenticate first.
    assert.match(text, /catalog is private/i);
    assert.doesNotMatch(text, /Capabilities \(mirrors get_menu\)/);
    // No secret-file locations or operator env-var names for anonymous visitors.
    assert.doesNotMatch(text, /bootstrap-token/);
    assert.doesNotMatch(text, /TELEGRAM_BOT_TOKEN/);
    assert.doesNotMatch(text, /SMITHERS_/);
  });

  it("builds the OpenAPI document with version and route summaries", () => {
    const doc = openApiDocument({ baseUrl: "https://hub.example", version: "1.2.3" });

    assert.equal(doc.openapi, "3.1.0");
    assert.equal(doc.info.version, "1.2.3");
    assert.deepEqual(doc.servers, [{ url: "https://hub.example/api" }]);
    assert.equal(doc.components.securitySchemes.bearerAuth.scheme, "bearer");
    assert.ok(doc.paths["/runs/{id}/timeline"].get.summary.includes("unified ascending run timeline"));
  });
});
