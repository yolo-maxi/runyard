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
  return decorateWorkflowGraph({
    name: capability?.name || capability?.slug || "Workflow",
    nodes,
    edges,
    sideNodes: capabilitySideNodes(capability),
    metadata: { taskCount: 1, parallelGroups: 0, sequenceGroups: 1 }
  });
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
  if (capabilityRequiresStartApproval(capability)) {
    nodes.push(capabilityStartApprovalNode(capability));
    edges.push(edgeBetween("workflow", "start-approval", { kind: "sequence", id: "capability-policy" }));
    frontier = ["start-approval"];
  }
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

  return decorateWorkflowGraph({
    nodes,
    edges,
    sideNodes: capabilitySideNodes(capability),
    metadata: {
      taskCount: tasks.length,
      parallelGroups: containers.filter((c) => c.kind === "parallel").length,
      sequenceGroups: containers.filter((c) => c.kind === "sequence").length
    }
  });
}

function decorateWorkflowGraph(graph) {
  const nodes = graph.nodes.map((node) => decorateNode(node));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const positions = workflowPositions(nodes);
  const decisionIds = new Set(nodes.filter((node) => node.kind === "decision").map((node) => node.id));
  const edges = graph.edges.map((edge) => {
    const target = nodeById.get(edge.target);
    const source = nodeById.get(edge.source);
    const kind = edge.kind === "parallel" ? "parallel" : target?.edgeKind || source?.edgeKind || "sequence";
    return {
      ...edge,
      kind,
      label: decisionIds.has(edge.source) ? "yes" : edge.kind === "parallel" ? "parallel" : "then"
    };
  });

  for (const node of nodes) {
    const position = positions.get(node.id) || { x: 0, y: 0 };
    node.position = position;
    node.sourcePosition = "right";
    node.targetPosition = "left";
    if (node.kind !== "decision") continue;

    const noId = `${node.id}-no`;
    const unknownId = `${node.id}-unknown`;
    nodes.push({
      id: noId,
      type: "decision-outcome",
      kind: "approval",
      label: "No / changes",
      owner: "Human response",
      sublabel: "Request changes or stop the run",
      position: { x: position.x - 6, y: position.y + 185 },
      sourcePosition: "top",
      targetPosition: "top"
    });
    nodes.push({
      id: unknownId,
      type: "decision-outcome",
      kind: "test",
      label: "?? Clarify",
      owner: "Needs context",
      sublabel: "Ask before continuing",
      position: { x: position.x - 6, y: position.y - 145 },
      sourcePosition: "bottom",
      targetPosition: "bottom"
    });
    edges.push({
      id: `e-${node.id}-${noId}`,
      source: node.id,
      sourceHandle: "source-bottom",
      target: noId,
      kind: "blocked",
      label: "no"
    });
    edges.push({
      id: `e-${node.id}-${unknownId}`,
      source: node.id,
      sourceHandle: "source-top",
      target: unknownId,
      kind: "policy",
      label: "?? clarify"
    });
  }

  return {
    ...graph,
    nodes,
    edges,
    layout: "operating-map",
    height: graph.metadata?.parallelGroups ? 620 : 540
  };
}

function capabilityRequiresStartApproval(capability = {}) {
  return capability?.approvalPolicy?.required === true;
}

function capabilityStartApprovalNode(capability = {}) {
  return {
    id: "start-approval",
    type: "approval",
    label: "Start approval",
    kind: "approval",
    sublabel: capability?.approvalPolicy?.reason || "Human approval required before this workflow runs",
    containerKind: "policy"
  };
}

function decorateNode(node) {
  const kind = node.kind === "approval" ? "decision" : node.kind;
  const owner = node.kind === "approval"
    ? "Human decision"
    : node.agent
      ? `Agent: ${node.agent}`
      : node.kind === "entry"
        ? "Workflow start"
        : ["build", "test", "verify", "deploy", "commit", "push"].includes(node.kind)
          ? "Agent/system step"
          : "System step";
  const edgeKind = node.kind === "approval"
    ? "human"
    : node.agent || ["build", "test", "verify", "deploy", "commit", "push"].includes(node.kind)
      ? "agent"
      : "sequence";
  return {
    ...node,
    kind,
    originalKind: node.kind,
    owner,
    edgeKind
  };
}

function workflowPositions(nodes) {
  const positions = new Map();
  const entry = nodes.find((node) => node.kind === "entry") || nodes[0];
  if (entry) positions.set(entry.id, { x: 40, y: 210 });
  let column = 1;
  let lastParallel = "";
  const parallelRows = new Map();
  for (const node of nodes) {
    if (node === entry) continue;
    if (node.containerKind === "parallel") {
      if (lastParallel !== node.containerId) {
        lastParallel = node.containerId;
        parallelRows.set(node.containerId, 0);
      }
      const row = parallelRows.get(node.containerId) || 0;
      parallelRows.set(node.containerId, row + 1);
      positions.set(node.id, { x: 40 + column * 300, y: 90 + row * 150 });
      continue;
    }
    if (lastParallel) {
      column += 1;
      lastParallel = "";
    }
    positions.set(node.id, { x: 40 + column * 300, y: node.kind === "decision" ? 190 : 210 });
    column += 1;
  }
  return positions;
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
