import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bearerFromRequest,
  requestOrigin,
  requireBodySlug,
  tokenRequestVia
} from "../src/requestContext.js";

describe("request context helpers", () => {
  it("classifies token origin without treating API tokens as MCP or runner calls", () => {
    assert.equal(tokenRequestVia({ scopes: ["mcp"] }), "mcp");
    assert.equal(tokenRequestVia({ scopes: ["runner"] }), "runner");
    assert.equal(tokenRequestVia({ scopes: ["api", "mcp"] }), "token");
    assert.equal(tokenRequestVia({ scopes: ["admin"] }), "token");
  });

  it("extracts bearer tokens and trims surrounding whitespace", () => {
    assert.equal(bearerFromRequest({ headers: { authorization: "Bearer shub_123  " } }), "shub_123");
    assert.equal(bearerFromRequest({ headers: { authorization: "Basic abc" } }), "");
  });

  it("combines token, headers, and explicit origin metadata", () => {
    const origin = requestOrigin({
      token: { id: "tok_1", name: "Agent", scopes: ["mcp"] },
      headers: {
        "x-smithers-origin": "Linear",
        "x-smithers-origin-url": "https://example.test/issue/1"
      },
      body: { origin: { label: "Explicit", messageId: "m1" } }
    }, {});

    assert.deepEqual(origin, {
      requestedBy: "mcp: Agent",
      origin: {
        label: "Explicit",
        type: "mcp",
        name: "Agent",
        scopes: ["mcp"],
        url: "https://example.test/issue/1",
        messageId: "m1"
      }
    });
  });

  it("uses slug, name, title, then fallback for body slugs", () => {
    assert.equal(requireBodySlug({ slug: "custom" }, "fallback"), "custom");
    assert.equal(requireBodySlug({ name: "My Workflow" }, "fallback"), "my-workflow");
    assert.equal(requireBodySlug({ title: "Ticket Triage" }, "fallback"), "ticket-triage");
    assert.equal(requireBodySlug({}, "fallback name"), "fallback-name");
  });
});
