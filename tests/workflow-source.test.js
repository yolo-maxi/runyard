import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

function api(pathname) {
  return fetch(`${baseUrl}${pathname}`, {
    headers: { authorization: `Bearer ${token}` }
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  });
}

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
  it("returns source, parsed metadata, sections, and a graph for a real workflow", async () => {
    const data = await api("/api/capabilities/implement-change-gated/source");
    assert.equal(data.available, true);
    assert.equal(data.slug, "implement-change-gated");
    assert.match(data.path, /workflow-templates\/workflows\/implement-change-gated\.tsx$/);
    assert.equal(data.language, "tsx");
    assert.ok(data.code.includes("smithers-display-name"));
    assert.ok(data.code.includes("<Workflow"));
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
    const data = await api("/api/capabilities/hello/source");
    if (!data.available) {
      assert.equal(data.slug, "hello");
      assert.ok(data.graph.nodes.length >= 2);
      assert.ok(data.graph.edges.length >= 1);
      return;
    }
    // The hello template ships, so we should at least get the parsed graph.
    assert.ok(data.graph.nodes.find((node) => node.kind === "entry"));
  });

  it("returns source and graph metadata for the run knowledge builder workflow", async () => {
    const data = await api("/api/capabilities/run-knowledge-builder/source");
    assert.equal(data.available, true);
    assert.equal(data.slug, "run-knowledge-builder");
    assert.match(data.path, /workflow-templates\/workflows\/run-knowledge-builder\.tsx$/);
    assert.equal(data.metadata.displayName, "Run Knowledge Builder");
    const taskIds = data.graph.nodes.filter((node) => node.kind !== "entry").map((node) => node.id);
    assert.ok(taskIds.includes("gather"));
    assert.ok(taskIds.includes("analyze"));
    assert.ok(taskIds.includes("report"));
    assert.ok(data.code.includes("run-knowledge-report.md"));
  });

  it("returns a PM-then-builder graph for the improve workflow", async () => {
    const data = await api("/api/capabilities/improve/source");
    assert.equal(data.available, true);
    assert.equal(data.slug, "improve");
    assert.equal(data.metadata.displayName, "Improve");
    const taskIds = data.graph.nodes.filter((node) => node.kind !== "entry").map((node) => node.id);
    assert.ok(taskIds.includes("review"), "improve should include a PM review node");
    assert.ok(taskIds.includes("implement"), "improve should dispatch a builder implementation node");
    assert.ok(taskIds.includes("test") && taskIds.includes("commit") && taskIds.includes("push"));
  });

  it("rejects unknown capabilities with 404", async () => {
    const res = await fetch(`${baseUrl}/api/capabilities/does-not-exist/source`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.status, 404);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/capabilities/hello/source`);
    assert.equal(res.status, 401);
  });
});

describe("Code viewer + ReactFlow asset surface", () => {
  it("ships the vendored ReactFlow and highlight.js bundles", () => {
    const vendor = path.join(process.cwd(), "public", "vendor");
    for (const file of ["reactflow.bundle.js", "highlight.bundle.js", "reactflow.css", "highlight.css", "manifest.json"]) {
      assert.ok(existsSync(path.join(vendor, file)), `expected vendor file ${file} to exist (run pnpm build:vendor)`);
    }
    const reactflowBundle = readFileSync(path.join(vendor, "reactflow.bundle.js"), "utf8");
    assert.ok(reactflowBundle.includes("ReactFlow"), "reactflow.bundle.js should export ReactFlow");
    const highlightBundle = readFileSync(path.join(vendor, "highlight.bundle.js"), "utf8");
    assert.ok(highlightBundle.length > 1000, "highlight.bundle.js should be non-empty");
  });

  it("the workflow detail surface references the source endpoint, ReactFlow, and highlight.js", async () => {
    const appJs = await raw("/public/app.js");
    assert.equal(appJs.status, 200);
    assert.match(appJs.text, /\/api\/capabilities\/.+\/source/);
    assert.match(appJs.text, /\/public\/vendor\/reactflow\.bundle\.js/);
    assert.match(appJs.text, /\/public\/vendor\/highlight\.bundle\.js/);
    assert.match(appJs.text, /workflow-tabs|WORKFLOW_TABS/);
    assert.match(appJs.text, /Visual graph/);
  });

  it("serves the vendored CSS and JS bundles to the browser", async () => {
    for (const file of ["reactflow.css", "highlight.css", "reactflow.bundle.js", "highlight.bundle.js"]) {
      const res = await raw(`/public/vendor/${file}`);
      assert.equal(res.status, 200, `expected /public/vendor/${file} to serve 200`);
      assert.ok(res.buffer.length > 100, `expected /public/vendor/${file} to be non-empty`);
    }
  });

  it("the app HTML links the vendored highlight.js + ReactFlow stylesheets", async () => {
    const res = await raw("/app");
    assert.equal(res.status, 200);
    assert.match(res.text, /\/public\/vendor\/highlight\.css/);
    assert.match(res.text, /\/public\/vendor\/reactflow\.css/);
  });
});
