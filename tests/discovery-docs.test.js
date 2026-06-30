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
    assert.equal(menu.capabilities[0].runWithCli, "runyard run hello --where local --input '{}'");
    assert.deepEqual(menu.capabilities[0].runWithMcp, {
      tool: "run_capability",
      arguments: { id: "hello", input: {}, executionMode: "local" }
    });
    assert.equal(menu.pool.online, 1);
  });

  it("renders llms.txt from the same menu payload", () => {
    const menu = hubMenuPayload({
      baseUrl: "https://hub.example",
      capabilities: [{ slug: "hello", name: "Hello", description: "Says hi" }]
    });
    const text = renderLlmsTxt(menu, "https://hub.example");

    assert.match(text, /^# Runyard \(codebase: runyard\)/);
    assert.match(text, /- OpenAPI: https:\/\/hub\.example\/openapi\.json/);
    assert.match(text, /- hello: Hello -- Says hi/);
    assert.match(text, /- local -> runners tagged local/);
    assert.ok(text.endsWith("\n"));
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
