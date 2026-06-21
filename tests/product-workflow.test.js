import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-product-workflow-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_product_workflow_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");

let server;
let baseUrl;
const token = "shub_product_workflow_token";

function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
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

describe("Product Workflow capability", () => {
  it("is seeded as a sequential Smithers product workflow", async () => {
    const { capabilities } = await api("/api/capabilities");
    const cap = capabilities.find((c) => c.slug === "product-workflow");
    assert.ok(cap, "product-workflow capability should be in the catalog");
    assert.equal(cap.workflow.engine, "smithers");
    assert.equal(cap.workflow.entry, ".smithers/workflows/product-workflow.tsx");
    assert.equal(cap.category, "Product");
    assert.deepEqual(cap.requiredRunnerTags, ["smithers"]);
    // Reuses the existing research / PM / implementation cards.
    assert.ok(cap.requiredAgents.includes("researcher"));
    assert.ok(cap.requiredAgents.includes("product-manager"));
    assert.ok(cap.requiredAgents.includes("implementation-agent"));
    assert.ok(cap.requiredSkills.includes("research-method"));
    assert.ok(cap.requiredSkills.includes("implementation"));
    assert.equal(cap.approvalPolicy.required, true);
  });

  it("exposes the expected sequential input schema, defaulting to the Runyard repo", async () => {
    const { capability } = await api("/api/capabilities/product-workflow");
    const props = capability.inputSchema.properties;
    assert.equal(props.context.type, "string");
    assert.equal(props.competitors.type, "string");
    assert.equal(props.maxCompetitors.type, "number");
    assert.equal(props.maxFeatures.type, "number");
    assert.equal(props.execute.type, "boolean");
    assert.equal(props.deploy.type, "boolean");
    assert.equal(props.targetBranch.type, "string");
    // Repo selector contract matches improve / implement-change-gated.
    assert.equal(props.repo.type, "string");
    assert.equal(props.project.type, "string");
    assert.equal(props.repoDir.type, "string");
    assert.match(props.repoDir.description, /runner-local git repo path/);
  });

  it("is source-viewable with a sequential research → feature map → prioritize → dispatch graph", async () => {
    const data = await api("/api/capabilities/product-workflow/source");
    assert.equal(data.available, true);
    assert.equal(data.slug, "product-workflow");
    assert.match(data.path, /workflow-templates\/workflows\/product-workflow\.tsx$/);
    assert.equal(data.metadata.displayName, "Product Workflow (sequential)");
    const taskIds = data.graph.nodes.filter((node) => node.kind !== "entry").map((node) => node.id);
    assert.ok(taskIds.includes("research"), "should include a competitor research node");
    assert.ok(taskIds.includes("featureMap"), "should include a feature map synthesis node");
    assert.ok(taskIds.includes("prioritize"), "should include a prioritization node");
    assert.ok(taskIds.includes("dispatch"), "should include a sequential implementation dispatch node");
    // Reuses the gated implementation contract rather than inventing a swarm.
    assert.ok(data.code.includes("implement-change-gated"));
  });

  it("ships the workflow template in the runner bundle", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "product-workflow.tsx");
    assert.ok(existsSync(tpl));
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /resolveImproveRepo/);
    assert.match(src, /ClaudeCodeAgent/);
    assert.match(src, /sequential/i);
  });

  it("fails fast instead of reporting a successful zero-feature plan when agent outputs are empty", () => {
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "product-workflow.tsx");
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /requireNonEmptyStage/);
    assert.match(src, /refusing to report a successful zero-feature plan/);
    assert.match(src, /research agent likely returned unparseable\/non-JSON output/);
    assert.match(src, /feature-map agent likely returned unparseable\/non-JSON output/);
    assert.match(src, /prioritization agent likely returned unparseable\/non-JSON output/);
    assert.match(src, /recoverAgentJsonFromEvents/);
    assert.match(src, /_smithers_events/);
    assert.match(src, /hydratedStage\(research/);
    assert.match(src, /hydratedStage\(featureMap/);
  });

  it("is supervised by the run-smithers envelope by default", async () => {
    const created = await api("/api/capabilities/product-workflow/run", {
      method: "POST",
      body: { input: { context: "tiny", maxFeatures: 1 } }
    });
    assert.equal(created.run.capabilitySlug, "product-workflow", "stays visible as the requested workflow");
    assert.equal(created.run.actualCapabilitySlug, "run-smithers", "is executed by the supervisor by default");
    assert.equal(created.supervising.wrappedCapability, "product-workflow");
  });

  it("queues immediately under supervision without a separate visible start approval", async () => {
    const created = await api("/api/capabilities/product-workflow/run", {
      method: "POST",
      body: { input: { context: "queued", maxFeatures: 1 } }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.actualCapabilitySlug, "run-smithers");
    // Like other supervised mutating workflows, the visible run carries no
    // separate pending start approval — supervision owns the envelope.
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });
});
