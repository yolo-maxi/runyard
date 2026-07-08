import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// "Capability" is the legacy/internal name for a workflow. It survives in
// storage identifiers, compat aliases, and deep-link params — but every
// user-facing surface says "workflow". These tests keep new capability
// wording from reappearing in discovery docs, MCP descriptions, OpenAPI
// summaries, the web UI, and the docs site, while explicitly allowing the
// documented legacy-alias contexts.

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { hubMenuPayload, renderLlmsTxt, openApiDocument } = await import("../src/discoveryDocs.js");
const { MCP_TOOLS } = await import("../src/mcpTools.js");

const CAPABILITY = /capabilit/i;

describe("capability wording stays out of user-facing copy", () => {
  it("llms.txt never says capability", () => {
    assert.doesNotMatch(renderLlmsTxt("https://hub.example"), CAPABILITY);
  });

  it("the menu payload never says capability", () => {
    const menu = hubMenuPayload({
      baseUrl: "https://hub.example",
      workflows: [{ slug: "improve", name: "Improve", description: "x", category: "dev", requiredRunnerTags: [], deepLink: "/x" }]
    });
    assert.doesNotMatch(JSON.stringify(menu), CAPABILITY);
  });

  it("MCP tool names, descriptions, and schemas never say capability", () => {
    for (const tool of MCP_TOOLS) {
      assert.doesNotMatch(JSON.stringify(tool), CAPABILITY, `MCP tool ${tool.name}`);
    }
  });

  it("openapi.json mentions capability only on deprecated aliases or explicit legacy notes", () => {
    const doc = openApiDocument({ baseUrl: "https://hub.example", version: "0.0.0" });
    for (const [pathKey, methods] of Object.entries(doc.paths)) {
      for (const [method, entry] of Object.entries(methods)) {
        const label = `${method.toUpperCase()} ${pathKey}`;
        if (pathKey.includes("capabilit")) {
          assert.equal(entry.deprecated, true, `${label} must be deprecated`);
          assert.match(entry.summary, /legacy/i, `${label} summary must call itself a legacy alias`);
        } else if (CAPABILITY.test(entry.summary)) {
          assert.match(entry.summary, /legacy/i, `${label} may mention capability only as a legacy alias`);
        }
        assert.ok(!pathKey.startsWith("/v1/") || !pathKey.includes("capabilit"), `${label}: no v1 capability paths`);
      }
    }
  });

  it("the web app renders no capability wording (identifiers and legacy params only)", () => {
    const allowed = /(capabilitySlug|capabilityName|capabilitySha|capability_slug|capabilities|\.capability\b|"capability"|'capability'|`capability`)/;
    const violations = [];
    for (const file of walk(path.join(repoRoot, "web"))) {
      if (!/\.(js|jsx)$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        if (!CAPABILITY.test(line)) return;
        const where = `${path.relative(repoRoot, file)}:${index + 1}`;
        if (/(?<![=)-])>[^<{()]*capabilit/i.test(line)) violations.push(`${where} renders capability text: ${line.trim()}`);
        else if (!allowed.test(line)) violations.push(`${where} unexpected capability wording: ${line.trim()}`);
      });
    }
    assert.deepEqual(violations, [], violations.join("\n"));
  });

  it("docs-site content mentions capability only in allowed legacy contexts", () => {
    const allowed = /(legacy|allowedCapabilities|capability tags)/i;
    const violations = [];
    for (const file of walk(path.join(repoRoot, "docs-site/content"))) {
      if (!file.endsWith(".mdx")) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        if (CAPABILITY.test(line) && !allowed.test(line)) {
          violations.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(violations, [], `docs must say workflow, not capability (or mark the line as legacy):\n${violations.join("\n")}`);
  });
});

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}
