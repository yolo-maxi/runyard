import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  deriveWorkflowGraph,
  loadWorkflowSource,
  MAX_WORKFLOW_BUNDLE_BYTES,
  parseWorkflowMetadata,
  sliceWorkflowSections,
  workflowBundleReference,
  workflowBundleSizeError,
  workflowSourceCandidates,
  workflowTemplatesDir
} from "../src/workflowSource.js";

describe("workflow source helpers", () => {
  it("resolves only sanitized workflow template basenames", () => {
    assert.deepEqual(
      workflowSourceCandidates({
        slug: "safe-slug",
        workflow: { entry: "../nested/unsafe.tsx" }
      }),
      ["unsafe.tsx", "unsafe.jsx", "unsafe.ts", "unsafe.js", "safe-slug.tsx", "safe-slug.jsx", "safe-slug.ts", "safe-slug.js"]
    );
  });

  it("loads checked-in style workflow templates from an explicit root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "runyard-workflow-source-"));
    const workflows = path.join(root, "workflow-templates", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(path.join(workflows, "demo.tsx"), "// smithers-display-name: Demo\nexport default null;\n");

    const source = loadWorkflowSource({ slug: "demo", workflow: { entry: ".smithers/workflows/demo.tsx" } }, { root });
    assert.equal(source.relativePath, path.join("workflow-templates", "workflows", "demo.tsx"));
    assert.equal(source.language, "tsx");
    assert.match(source.code, /smithers-display-name/);
    assert.equal(source.sizeBytes, Buffer.byteLength(source.code, "utf8"));
  });

  it("resolves DB-backed bundles through the injected bundle store", () => {
    const capability = { slug: "db-flow", workflow: { bundleId: "wfb_1" } };
    assert.equal(workflowBundleReference(capability), "wfb_1");
    assert.equal(workflowBundleReference({ slug: "file-flow", workflow: {} }), null);

    const source = loadWorkflowSource(capability, {
      getWorkflowBundle: (bundleId) => ({
        id: bundleId,
        capabilitySlug: "db-flow",
        version: 2,
        language: "tsx",
        sizeBytes: 12,
        sha256: "deadbeef",
        code: "export nil;\n"
      })
    });

    assert.equal(source.bundleId, "wfb_1");
    assert.equal(source.bundleVersion, 2);
    assert.equal(source.sha256, "deadbeef");
    assert.equal(source.relativePath, "db://workflow-bundles/wfb_1");
    assert.equal(source.language, "tsx");
    assert.equal(source.sizeBytes, 12);
    assert.equal(source.code, "export nil;\n");
  });

  it("fails clearly when a configured DB bundle is missing instead of falling back to a file", () => {
    // A matching template file exists — the bundle reference must still win
    // and the missing bundle must be a hard error, never a silent fallback.
    const root = mkdtempSync(path.join(os.tmpdir(), "runyard-db-bundle-"));
    const workflows = path.join(root, "workflow-templates", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(path.join(workflows, "db-flow.tsx"), "export default null;\n");

    const capability = { slug: "db-flow", workflow: { bundleId: "wfb_missing" } };
    for (const options of [{ root }, { root, getWorkflowBundle: () => null }]) {
      assert.throws(
        () => loadWorkflowSource(capability, options),
        (error) => {
          assert.equal(error.code, "workflow_bundle_missing");
          assert.equal(error.bundleId, "wfb_missing");
          assert.match(error.message, /db-flow/);
          assert.match(error.message, /wfb_missing/);
          assert.match(error.message, /refusing to fall back/);
          return true;
        }
      );
    }
  });

  it("accepts bundles at the 500 KB cap and rejects bundles over it with a debuggable error", () => {
    assert.equal(workflowBundleSizeError(null), null);
    assert.equal(workflowBundleSizeError({ sizeBytes: 100, relativePath: "small.tsx" }), null);
    assert.equal(workflowBundleSizeError({ sizeBytes: MAX_WORKFLOW_BUNDLE_BYTES }), null);

    const oversized = {
      sizeBytes: MAX_WORKFLOW_BUNDLE_BYTES + 1,
      relativePath: path.join("workflow-templates", "workflows", "huge.tsx")
    };
    const error = workflowBundleSizeError(oversized);
    assert.match(error, /huge\.tsx/);
    assert.match(error, new RegExp(`is ${MAX_WORKFLOW_BUNDLE_BYTES + 1} bytes`));
    assert.match(error, /500 KB/);
    assert.match(error, new RegExp(`${MAX_WORKFLOW_BUNDLE_BYTES} byte`));
  });

  it("keeps every shipped workflow template under the 500 KB bundle cap", () => {
    const templatesDir = workflowTemplatesDir(process.cwd());
    const templates = readdirSync(templatesDir);
    assert.ok(templates.length > 0, "expected shipped workflow templates");
    for (const file of templates) {
      const { size } = statSync(path.join(templatesDir, file));
      assert.ok(
        size <= MAX_WORKFLOW_BUNDLE_BYTES,
        `${file} is ${size} bytes, over the ${MAX_WORKFLOW_BUNDLE_BYTES} byte workflow bundle cap`
      );
    }
  });

  it("parses metadata, source sections, and graph nodes from workflow JSX", () => {
    const code = `// smithers-display-name: Demo Flow
// smithers-category: Utility

const agent = new ClaudeCodeAgent();

<Workflow name="Demo Flow">
  <Sequence>
    <Task id="build" agent={agent} output={buildOutput} retries={2} />
    <Parallel maxConcurrency={2}>
      <Task id={\`audit-\${i + 1}\`} agent={agent} />
      <Task id="deploy" agent={agent}>systemctl reload runyard</Task>
    </Parallel>
  </Sequence>
</Workflow>`;

    assert.deepEqual(parseWorkflowMetadata(code), { displayName: "Demo Flow", category: "Utility" });
    const sections = sliceWorkflowSections(code);
    assert.match(sections.agents.text, /ClaudeCodeAgent/);
    assert.match(sections.workflowGraph.text, /<Workflow/);

    const graph = deriveWorkflowGraph(code, {
      slug: "demo",
      workflow: { engine: "smithers" },
      requiredAgents: ["builder"],
      requiredSkills: ["shell"],
      requiredRunnerTags: ["local"]
    });
    assert.equal(graph.name, "Demo Flow");
    assert.equal(graph.metadata.taskCount, 3);
    assert.ok(graph.nodes.find((node) => node.id === "audit-N"));
    assert.equal(graph.nodes.find((node) => node.id === "deploy").kind, "deploy");
    assert.deepEqual(graph.sideNodes.map((node) => node.id), ["agent:builder", "skill:shell", "tag:local"]);
  });
});
