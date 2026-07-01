import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanWorkflowTasks, taskNode } from "../src/workflowGraphTasks.js";

describe("workflow graph task scanner", () => {
  it("scans workflow task metadata and classifies semantic task kinds", () => {
    const code = `<Workflow name="Demo">
  <Sequence>
    <Task id="build" agent={builder} output={buildOutput} retries={2} />
    <Parallel maxConcurrency={2}>
      <Task id={\`audit-\${i}\`} agent={builder} />
      <Task id="deploy" agent={builder}>systemctl reload runyard</Task>
    </Parallel>
    <Task id="approval">createApproval()</Task>
  </Sequence>
</Workflow>`;

    const scan = scanWorkflowTasks(code, "Fallback");

    assert.equal(scan.workflowName, "Demo");
    assert.deepEqual(scan.containers.map((container) => container.kind), ["sequence", "parallel"]);
    assert.deepEqual(scan.tasks.map((task) => task.id), ["build", "audit-N", "deploy", "approval"]);
    assert.deepEqual(scan.tasks.map((task) => task.kind), ["build", "task", "deploy", "approval"]);

    const node = taskNode(scan.tasks[0]);
    assert.equal(node.sublabel, "agent builder · retries=2 · out=buildOutput");
  });
});
