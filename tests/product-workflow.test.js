import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonApiClient } from "./http-client.js";

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
const api = createJsonApiClient({ baseUrl: () => baseUrl, token });

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
    // deploy is deprecated and no longer advertised; deploys are post-run hooks.
    assert.equal(props.deploy, undefined);
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
    assert.match(src, /NodeOutput/);
    assert.match(src, /AgentEvent/);
    assert.match(src, /bun:sqlite/);
    assert.match(src, /hydratedStage\(research/);
    assert.match(src, /hydratedStage\(featureMap/);
  });

  it("researchReady never emits invalid null fields and fails actionably when research is genuinely empty", () => {
    // Source-level contract: the researchReady task chains assertResearchReady
    // around normalizeResearch + hydratedStage so the schema never sees nulls,
    // and the workflow fails fast with an actionable error when the upstream
    // research payload is genuinely empty.
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "product-workflow.tsx");
    const src = readFileSync(tpl, "utf8");
    assert.match(src, /function normalizeResearch/);
    assert.match(src, /function assertResearchReady/);
    assert.match(src, /assertResearchReady\(normalizeResearch\(await hydratedStage\(research/);
    // The actionable error must name the workflow, the failing node, the
    // schema, and the missing fields so the operator can act on it.
    assert.match(src, /product-workflow node 'researchReady'/);
    assert.match(src, /schema researchOut/);
    assert.match(src, /missing: competitors/);
    assert.match(src, /silently reporting zero competitors/);
  });

  it("assertResearchReady throws on the exact null payload that broke run-1782060314224", async () => {
    // Drive the helper directly by extracting it from source. The workflow is a
    // .tsx (JSX-in-JS) so we can't import it; eval is acceptable here because
    // we only execute our own checked-in source. This locks the runtime
    // behavior — not just the source string — to the regression we just fixed.
    const tpl = path.join(process.cwd(), "workflow-templates", "workflows", "product-workflow.tsx");
    const src = readFileSync(tpl, "utf8");
    const slice = (name) => {
      const start = src.indexOf(`function ${name}(`);
      if (start === -1) throw new Error(`could not locate helper ${name}`);
      // Walk braces from the first `{` after the signature to find the close.
      let depth = 0;
      let i = src.indexOf("{", start);
      const begin = i;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) return src.slice(start, i + 1);
        }
      }
      throw new Error(`unterminated helper ${name}`);
    };
    const helperSource =
      slice("arrayFromMaybeJson") +
      "\n" +
      slice("coerceString") +
      "\n" +
      slice("coerceStringArray") +
      "\n" +
      slice("normalizeResearch") +
      "\n" +
      slice("assertResearchReady") +
      "\nreturn { normalizeResearch, assertResearchReady };";
    const { normalizeResearch, assertResearchReady } = new Function(helperSource)();

    // 1) The exact persisted shape from the live regression — all four fields
    //    null. normalize must coerce nulls into the schema's expected types so
    //    the validator never sees a null again.
    const persistedNullStage = { summary: null, competitors: null, sources: null, openQuestions: null };
    const normalized = normalizeResearch(persistedNullStage);
    assert.equal(normalized.summary, "");
    assert.deepEqual(normalized.competitors, []);
    assert.deepEqual(normalized.sources, []);
    assert.deepEqual(normalized.openQuestions, []);

    // 2) But: "no structured competitors after coercion" = unusable research → assert
    //    must throw an actionable error that names the workflow, node, schema,
    //    and missing fields. No silent success path.
    assert.throws(
      () => assertResearchReady(normalized),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /product-workflow node 'researchReady'/);
        assert.match(err.message, /schema researchOut/);
        assert.match(err.message, /missing: competitors/);
        return true;
      }
    );

    // 3) Same payload variants — empty arrays / undefined fields / nullish
    //    stage — must all throw, never validate as a successful empty plan.
    for (const stage of [{}, undefined, null, { summary: "   ", competitors: [], sources: [], openQuestions: [] }]) {
      assert.throws(() => assertResearchReady(normalizeResearch(stage)), /refused to emit an empty\/null payload/);
    }

    // 4) A summary-only result still fails because the final report would show
    //    "Competitors mapped (0)".
    assert.throws(
      () => assertResearchReady(normalizeResearch({ summary: "competitor scan complete; see notes" })),
      /missing: competitors/
    );

    const oneCompetitor = assertResearchReady(
      normalizeResearch({
        summary: null,
        competitors: [{ name: "Alpha", url: { url: "https://alpha.example" }, features: [{ title: "F1" }, "F2"] }],
        sources: [{ url: "https://src.example" }, "https://raw.example"],
        openQuestions: null
      })
    );
    assert.equal(oneCompetitor.summary, "");
    assert.equal(oneCompetitor.competitors.length, 1);
    assert.equal(oneCompetitor.competitors[0].name, "Alpha");
    // Object-with-url collapses to the url string per coerceString.
    assert.equal(oneCompetitor.competitors[0].url, "https://alpha.example");
    assert.deepEqual(oneCompetitor.competitors[0].features, ["F1", "F2"]);
    assert.deepEqual(oneCompetitor.sources, ["https://src.example", "https://raw.example"]);
    assert.deepEqual(oneCompetitor.openQuestions, []);
  });

  it("queues directly without a wrapper envelope", async () => {
    const created = await api("/api/capabilities/product-workflow/run", {
      method: "POST",
      body: { input: { context: "tiny", maxFeatures: 1 } }
    });
    assert.equal(created.run.capabilitySlug, "product-workflow", "stays visible as the requested workflow");
    assert.equal(created.run.actualCapabilitySlug, undefined, "executes directly with no hidden wrapper");
  });

  it("queues immediately without a separate visible start approval", async () => {
    const created = await api("/api/capabilities/product-workflow/run", {
      method: "POST",
      body: { input: { context: "queued", maxFeatures: 1 } }
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.actualCapabilitySlug, undefined);
    const approval = (await api("/api/approvals?status=pending")).approvals.find((item) => item.runId === created.run.id);
    assert.equal(approval, undefined);
  });
});
