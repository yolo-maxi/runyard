import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveWorkflowGraph,
  deriveWorkflowGraphFromMetadata
} from "../src/workflowGraph.js";

describe("workflow graph helpers", () => {
  it("derives task nodes, lanes, side nodes, and semantic task kinds from JSX", () => {
    const code = `<Workflow name="Demo">
  <Sequence>
    <Task id="build" agent={builder} output={buildOutput} retries={2} />
    <Task id="test" agent={builder}>pnpm test</Task>
    <Parallel maxConcurrency={2}>
      <Task id={\`audit-\${i}\`} agent={builder} />
      <Task id="deploy" agent={builder}>systemctl reload runyard</Task>
    </Parallel>
    <Task id="approval">createApproval()</Task>
  </Sequence>
</Workflow>`;

    const graph = deriveWorkflowGraph(code, {
      slug: "demo",
      workflow: { engine: "smithers" },
      requiredAgents: ["builder"],
      requiredSkills: ["shell"],
      requiredRunnerTags: ["local"]
    });

    assert.equal(graph.name, "Demo");
    assert.equal(graph.metadata.taskCount, 5);
    assert.equal(graph.metadata.parallelGroups, 1);
    assert.equal(graph.nodes.find((node) => node.id === "test").kind, "test");
    assert.equal(graph.nodes.find((node) => node.id === "deploy").kind, "deploy");
    const approval = graph.nodes.find((node) => node.id === "approval");
    assert.equal(approval.kind, "decision");
    assert.equal(approval.originalKind, "approval");
    assert.equal(approval.owner, "Human decision");
    assert.ok(approval.position);
    assert.ok(graph.nodes.find((node) => node.id === "approval-no"));
    assert.ok(graph.nodes.find((node) => node.id === "approval-unknown"));
    assert.ok(graph.edges.find((edge) => edge.source === "approval" && edge.label === "no"));
    assert.ok(graph.edges.find((edge) => edge.source === "approval" && edge.label === "?? clarify"));
    assert.ok(graph.edges.find((edge) => edge.source === "test" && edge.target === "audit-N" && edge.kind === "parallel"));
    assert.ok(graph.edges.find((edge) => edge.label === "then"));
    assert.equal(graph.layout, "operating-map");
    assert.deepEqual(graph.sideNodes.map((node) => node.id), ["agent:builder", "skill:shell", "tag:local"]);
  });

  it("builds a small metadata-only fallback graph", () => {
    const graph = deriveWorkflowGraphFromMetadata({
      slug: "hello",
      name: "Hello",
      category: "Examples",
      workflow: { engine: "smithers", entry: ".smithers/workflows/hello.tsx" },
      requiredAgents: ["runner"]
    });
    assert.equal(graph.name, "Hello");
    assert.deepEqual(graph.nodes.map((node) => node.id), ["workflow", "execute"]);
    assert.deepEqual(graph.edges, [{ id: "e-workflow-execute", source: "workflow", target: "execute", kind: "sequence", label: "then" }]);
    assert.equal(graph.layout, "operating-map");
    assert.ok(graph.nodes.every((node) => node.position));
    assert.equal(graph.sideNodes[0].id, "agent:runner");
  });
});
