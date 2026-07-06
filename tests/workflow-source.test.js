import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonApiClient } from "./http-client.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-source-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_test_token_source";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");

let server;
let baseUrl;
const token = "shub_test_token_source";
const improveSource = readFileSync(new URL("../workflow-templates/workflows/improve.tsx", import.meta.url), "utf8");
const ideaToProductSource = readFileSync(new URL("../workflow-templates/workflows/idea-to-product.tsx", import.meta.url), "utf8");
const api = createJsonApiClient({ baseUrl: () => baseUrl, token });

function raw(pathname) {
  return fetch(`${baseUrl}${pathname}`).then(async (response) => {
    const buf = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, buffer: buf, text: buf.toString("utf8") };
  });
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("Workflow source + code viewer", () => {
  it("keeps Improve repo resolution explicit and no-op success gated", () => {
    assert.doesNotMatch(improveSource, /probeRunyardRepoFallback/);
    assert.doesNotMatch(improveSource, /applyRunyardRepoFallback/);
    assert.match(improveSource, /GATE FAILED: improve produced no changed files/);
    assert.match(improveSource, /noChangeEvidence/);
  });

  it("ships server-backed idea product publishing behind the explicit static-publish hook", () => {
    assert.match(ideaToProductSource, /function deployServerBackedProduct/);
    assert.match(ideaToProductSource, /server\/index\.mjs/);
    assert.match(ideaToProductSource, /REPOBOX_SERVICE_PORT_START/);
    assert.match(ideaToProductSource, /reverse_proxy 127\.0\.0\.1:\$\{port\}/);
    assert.match(ideaToProductSource, /command -v bun/);
    assert.match(ideaToProductSource, /publishKind: serverBacked \? "service" : "static"/);
    // Publishing is an explicit post-run hook, never an implicit deploy step.
    assert.match(ideaToProductSource, /id="hooks"/);
    assert.doesNotMatch(ideaToProductSource, /id="deploy"/);
    assert.match(ideaToProductSource, /postRunHooks/);
  });

  it("returns source, parsed metadata, sections, and a graph for a real workflow", async () => {
    const data = await api("/api/workflows/implement-change-gated/source");
    assert.equal(data.available, true);
    assert.equal(data.slug, "implement-change-gated");
    assert.match(data.path, /workflow-templates\/workflows\/implement-change-gated\.tsx$/);
    assert.equal(data.language, "tsx");
    assert.ok(data.code.includes("smithers-display-name"));
    assert.ok(data.code.includes("<Workflow"));
    // Legacy deploy=true is a deprecated no-op reported as hook_config_required,
    // never an inline prod deploy (and never a preflight run failure).
    assert.ok(data.code.includes("deploy=true is deprecated and no longer deploys"));
    assert.equal(data.metadata.displayName, "Implement Change (gated)");
    assert.ok(typeof data.metadata.description === "string" && data.metadata.description.length > 5);

    assert.ok(data.sections.code.text.length > 100);
    assert.ok(data.sections.workflowGraph.text.includes("<Workflow") || data.sections.workflowGraph.text.includes("<Task"));
    assert.ok(data.sections.agents.text.includes("Agent") || data.sections.agents.text.includes("agent"));

    assert.ok(Array.isArray(data.graph.nodes));
    assert.ok(Array.isArray(data.graph.edges));
    assert.ok(data.graph.nodes.find((node) => node.kind === "entry"));
    const taskIds = data.graph.nodes.filter((node) => node.kind !== "entry").map((node) => node.id);
    assert.ok(taskIds.includes("baseline"));
    assert.ok(taskIds.includes("implement"));
    assert.ok(taskIds.includes("commit"));
    assert.ok(data.graph.metadata.taskCount >= 5);
    assert.ok(data.graph.edges.find((edge) => edge.source === "workflow"));
  });

  it("returns a metadata-only graph when source is missing", async () => {
    const data = await api("/api/workflows/hello/source");
    if (!data.available) {
      assert.equal(data.slug, "hello");
      assert.ok(data.graph.nodes.length >= 2);
      assert.ok(data.graph.edges.length >= 1);
      return;
    }
    // The hello template ships, so we should at least get the parsed graph.
    assert.ok(data.graph.nodes.find((node) => node.kind === "entry"));
  });

  it("returns source and graph metadata for the idea-to-product workflow", async () => {
    const data = await api("/api/workflows/idea-to-product/source");
    assert.equal(data.available, true);
    assert.equal(data.slug, "idea-to-product");
    assert.match(data.path, /workflow-templates\/workflows\/idea-to-product\.tsx$/);
    assert.equal(data.metadata.displayName, "Idea to Product");
    const taskIds = data.graph.nodes.filter((node) => node.kind !== "entry").map((node) => node.id);
    assert.ok(taskIds.includes("expand"));
    assert.ok(taskIds.includes("narrow"));
    assert.ok(taskIds.includes("build"));
    assert.ok(taskIds.includes("verify"));
    assert.ok(data.code.includes("server-backed"));
  });

  it("returns a PM-then-builder graph for the improve workflow", async () => {
    const data = await api("/api/workflows/improve/source");
    assert.equal(data.available, true);
    assert.equal(data.slug, "improve");
    assert.equal(data.metadata.displayName, "Improve");
    const taskIds = data.graph.nodes.filter((node) => node.kind !== "entry").map((node) => node.id);
    assert.ok(taskIds.includes("review"), "improve should include a PM review node");
    assert.ok(taskIds.includes("implement"), "improve should dispatch a builder implementation node");
    assert.ok(taskIds.includes("test") && taskIds.includes("commit") && taskIds.includes("push"));
  });

  it("rejects unknown workflows with 404", async () => {
    const res = await fetch(`${baseUrl}/api/workflows/does-not-exist/source`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 404);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/workflows/hello/source`);
    assert.equal(res.status, 401);
  });
});

describe("Code viewer + ReactFlow asset surface", () => {
  it("ships only the vendored ReactFlow and highlight.js stylesheets", () => {
    const vendor = path.join(process.cwd(), "public", "vendor");
    for (const file of ["reactflow.css", "highlight.css", "highlight-dark.css", "manifest.json"]) {
      assert.ok(existsSync(path.join(vendor, file)), `expected vendor file ${file} to exist (run pnpm build:vendor)`);
    }
    assert.ok(!existsSync(path.join(vendor, "reactflow.bundle.js")), "ReactFlow JS should be bundled into public/app.js");
    assert.ok(!existsSync(path.join(vendor, "highlight.bundle.js")), "highlight.js should be bundled into public/app.js");
  });

  it("the workflow detail surface references the source endpoint, ReactFlow, and highlight.js", () => {
    // The React rewrite imports @xyflow/react and highlight.js directly, so the
    // self-contained bundle no longer references the vendor bundle PATHS. Assert
    // the equivalent constructs in the new web/ source instead.
    const workflowDetail = readFileSync(path.join(process.cwd(), "web", "views", "WorkflowDetail.jsx"), "utf8");
    const workflowGraph = readFileSync(path.join(process.cwd(), "web", "components", "WorkflowGraph.jsx"), "utf8");
    const codeBlock = readFileSync(path.join(process.cwd(), "web", "components", "CodeBlock.jsx"), "utf8");

    // WorkflowDetail.jsx drives the source endpoint, the tab table, and the
    // "Visual graph" label.
    assert.match(workflowDetail, /\/api\/workflows\/.+\/source/);
    assert.match(workflowDetail, /WORKFLOW_TABS/);
    assert.match(workflowDetail, /Visual graph/);
    // The graph canvas renders via @xyflow/react (formerly the vendored ReactFlow bundle).
    assert.match(workflowGraph, /from "@xyflow\/react"/);
    // The code viewer highlights via highlight.js (formerly the vendored highlight bundle).
    assert.match(codeBlock, /from "highlight\.js/);
  });

  it("serves the vendored CSS bundles to the browser", async () => {
    for (const file of ["reactflow.css", "highlight.css", "highlight-dark.css"]) {
      const res = await raw(`/public/vendor/${file}`);
      assert.equal(res.status, 200, `expected /public/vendor/${file} to serve 200`);
      assert.ok(res.buffer.length > 100, `expected /public/vendor/${file} to be non-empty`);
    }
    assert.equal((await raw("/public/vendor/reactflow.bundle.js")).status, 404);
    assert.equal((await raw("/public/vendor/highlight.bundle.js")).status, 404);
  });

  it("the app HTML links the vendored highlight.js + ReactFlow stylesheets", async () => {
    const res = await raw("/app");
    assert.equal(res.status, 200);
    assert.match(res.text, /\/public\/vendor\/highlight\.css/);
    assert.match(res.text, /\/public\/vendor\/reactflow\.css/);
  });
});
