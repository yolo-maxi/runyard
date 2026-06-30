import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  deriveWorkflowGraph,
  loadWorkflowSource,
  parseWorkflowMetadata,
  sliceWorkflowSections,
  workflowSourceCandidates
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
