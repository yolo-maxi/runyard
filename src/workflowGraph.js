import { scanWorkflowTasks, taskNode } from "./workflowGraphTasks.js";

// Walk JSX once, tracking Sequence/Parallel containers. The returned graph is
// the shared shape for ReactFlow and the plain SVG fallback.
export function deriveWorkflowGraph(code, capability = {}) {
  const { containers, tasks, workflowName } = scanWorkflowTasks(code, capability?.name || "");

  return {
    name: workflowName || capability?.name || capability?.slug || "Workflow",
    ...graphFromTasks(tasks, capability, containers, workflowName)
  };
}

export function deriveWorkflowGraphFromMetadata(capability = {}) {
  const nodes = [
    {
      id: "workflow",
      type: "entry",
      kind: "entry",
      label: capability?.name || capability?.slug || "Workflow",
      sublabel: capability?.workflow?.engine ? `engine ${capability.workflow.engine}` : ""
    },
    {
      id: "execute",
      type: "task",
      kind: "task",
      label: capability?.workflow?.entry || capability?.workflow?.name || "execute",
      sublabel: capability?.category || ""
    }
  ];
  const edges = [{ id: "e-workflow-execute", source: "workflow", target: "execute", kind: "sequence" }];
  return {
    name: capability?.name || capability?.slug || "Workflow",
    nodes,
    edges,
    sideNodes: capabilitySideNodes(capability),
    metadata: { taskCount: 1, parallelGroups: 0, sequenceGroups: 1 }
  };
}

function graphFromTasks(tasks, capability, containers, workflowName) {
  const nodes = [
    {
      id: "workflow",
      type: "entry",
      label: workflowName || capability?.name || capability?.slug || "Workflow",
      kind: "entry",
      sublabel: capability?.workflow?.engine ? `engine ${capability.workflow.engine}` : ""
    }
  ];
  const edges = [];
  let frontier = ["workflow"];
  let openParallel = null;
  let parallelFanIn = [];

  for (const task of tasks) {
    nodes.push(taskNode(task));
    if (task.container?.kind === "parallel") {
      if (openParallel !== task.container.id) {
        if (parallelFanIn.length) frontier = parallelFanIn;
        openParallel = task.container.id;
        parallelFanIn = [];
      }
      for (const src of frontier) edges.push(edgeBetween(src, task.id, task.container));
      parallelFanIn.push(task.id);
      continue;
    }
    if (parallelFanIn.length) {
      frontier = parallelFanIn;
      parallelFanIn = [];
      openParallel = null;
    }
    for (const src of frontier) edges.push(edgeBetween(src, task.id, task.container));
    frontier = [task.id];
  }

  return {
    nodes,
    edges,
    sideNodes: capabilitySideNodes(capability),
    metadata: {
      taskCount: tasks.length,
      parallelGroups: containers.filter((c) => c.kind === "parallel").length,
      sequenceGroups: containers.filter((c) => c.kind === "sequence").length
    }
  };
}

function capabilitySideNodes(capability) {
  return [
    ...(capability?.requiredAgents || []).map((agent) => ({ id: `agent:${agent}`, type: "agent", label: agent, kind: "agent" })),
    ...(capability?.requiredSkills || []).map((skill) => ({ id: `skill:${skill}`, type: "skill", label: skill, kind: "skill" })),
    ...(capability?.requiredRunnerTags || []).map((tag) => ({ id: `tag:${tag}`, type: "tag", label: tag, kind: "tag" }))
  ];
}

function edgeBetween(source, target, container) {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    kind: container?.kind || "sequence",
    container: container?.id || ""
  };
}
