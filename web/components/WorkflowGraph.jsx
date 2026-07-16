import { useCallback, useMemo, useRef } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, MiniMap, Position } from "@xyflow/react";

// Visual graph tab renderer. The graph data comes from
// GET /api/workflows/:id/source → `.graph` (nodes/edges/sideNodes). We
// replicate the legacy layout (BFS rank → columns), node-color-by-kind palette,
// and edge styling (parallel = animated/dashed cyan, sequence = solid grey)
// exactly so the canvas reads identically to the vanilla build.

// BFS rank from the entry node → column/row positions. Ported 1:1 from the
// legacy layoutGraph().
function layoutGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (nodes.some((node) => node.position)) {
    return new Map(nodes.map((node) => [node.id, node.position || { x: 0, y: 0 }]));
  }
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) if (adjacency.has(edge.source)) adjacency.get(edge.source).push(edge.target);
  const rank = new Map();
  const entry = nodes.find((node) => node.kind === "entry") || nodes[0];
  if (!entry) return new Map();
  const queue = [[entry.id, 0]];
  rank.set(entry.id, 0);
  while (queue.length) {
    const [id, r] = queue.shift();
    for (const next of adjacency.get(id) || []) {
      if (!rank.has(next) || rank.get(next) < r + 1) {
        rank.set(next, r + 1);
        queue.push([next, r + 1]);
      }
    }
  }
  for (const node of nodes) if (!rank.has(node.id)) rank.set(node.id, 0);
  const columns = new Map();
  for (const node of nodes) {
    const column = rank.get(node.id) ?? 0;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  }
  const positions = new Map();
  const columnWidth = 230;
  const rowHeight = 110;
  for (const [column, items] of columns.entries()) {
    items.forEach((node, index) => {
      const x = column * columnWidth;
      const y = (index - (items.length - 1) / 2) * rowHeight;
      positions.set(node.id, { x, y });
    });
  }
  return positions;
}

function flowPosition(value, fallback) {
  switch (value) {
    case "top": return Position.Top;
    case "right": return Position.Right;
    case "bottom": return Position.Bottom;
    case "left": return Position.Left;
    default: return fallback;
  }
}

// Node fill/text/border by node kind. Ported 1:1 from the legacy nodeColor().
function nodeColor(kind) {
  switch (kind) {
    case "entry": return { background: "#0f766e", color: "#fff", border: "#0d5e57" };
    case "approval": return { background: "#fffbeb", color: "#b45309", border: "#fcd34d" };
    case "deploy": return { background: "#ecfeff", color: "#0e7490", border: "#67e8f9" };
    case "test": return { background: "#eef2ff", color: "#4338ca", border: "#a5b4fc" };
    case "commit":
    case "push": return { background: "#f5f3ff", color: "#6d28d9", border: "#c4b5fd" };
    case "build": return { background: "#fef3c7", color: "#92400e", border: "#fcd34d" };
    case "verify": return { background: "#dcfce7", color: "#166534", border: "#86efac" };
    case "agent":
    case "skill":
    case "tag": return { background: "#f1f5f9", color: "#334155", border: "#cbd5f5" };
    default: return { background: "#ffffff", color: "#15191f", border: "#d9e0ea" };
  }
}

// Per-run flow state palette (Work-item execution flow). Nodes without a
// `state` — every WorkflowDetail graph node — keep the kind palette above, so
// the static graph tab renders exactly as before.
function stateColor(state) {
  switch (state) {
    case "done": return { background: "#dcfce7", color: "#166534", border: "#86efac" };
    case "active": return { background: "#e0f2fe", color: "#075985", border: "#38bdf8" };
    case "failed": return { background: "#fef2f2", color: "#b91c1c", border: "#fca5a5" };
    case "waiting": return { background: "#fffbeb", color: "#b45309", border: "#fcd34d" };
    case "cancelled":
    case "skipped": return { background: "#f1f5f9", color: "#64748b", border: "#cbd5e1" };
    default: return null; // pending → kind palette, dimmed by opacity below
  }
}

function nodeLabel(node) {
  const lines = [node.label || node.id];
  if (node.owner) lines.push(node.owner);
  if (node.sublabel) lines.push(node.sublabel);
  if (node.state && node.state !== "pending" && node.kind !== "entry") lines.push(node.state);
  return lines.join("\n");
}

function DecisionNode({ data }) {
  return (
    <div className="workflow-decision-node">
      <Handle id="target-left" type="target" position={Position.Left} />
      <Handle id="target-top" type="target" position={Position.Top} />
      <div className="workflow-decision-inner">
        <strong>{data.title}</strong>
        {data.owner ? <span>{data.owner}</span> : null}
        {data.detail ? <small>{data.detail}</small> : null}
      </div>
      <Handle id="source-right" type="source" position={Position.Right} />
      <Handle id="source-bottom" type="source" position={Position.Bottom} />
      <Handle id="source-top" type="source" position={Position.Top} />
    </div>
  );
}

const nodeTypes = { decision: DecisionNode };

// Build the ReactFlow node array. Mirrors mountReactFlowGraph()'s node styling.
function toReactNodes(graph, positions) {
  return (graph.nodes || []).map((node) => {
    const palette = (node.kind !== "entry" && node.state && stateColor(node.state)) || nodeColor(node.kind);
    if (node.kind === "decision") {
      return {
        id: node.id,
        data: {
          title: node.label || node.id,
          owner: node.owner || "",
          detail: node.sublabel || ""
        },
        position: positions.get(node.id) || { x: 0, y: 0 },
        type: "decision",
        sourcePosition: flowPosition(node.sourcePosition, Position.Right),
        targetPosition: flowPosition(node.targetPosition, Position.Left)
      };
    }
    return {
      id: node.id,
      data: { label: nodeLabel(node) },
      position: positions.get(node.id) || { x: 0, y: 0 },
      style: {
        borderRadius: 10,
        border: `1px solid ${palette.border}`,
        background: palette.background,
        color: palette.color,
        padding: "10px 14px",
        minWidth: 168,
        fontSize: 13,
        boxShadow: "0 4px 12px rgba(15, 25, 35, 0.08)",
        ...(node.state === "pending" ? { opacity: 0.55 } : {})
      },
      className: `workflow-node workflow-node-${node.kind || "default"}`,
      sourcePosition: flowPosition(node.sourcePosition, Position.Right),
      targetPosition: flowPosition(node.targetPosition, Position.Left),
      type: node.kind === "entry" ? "input" : "default"
    };
  });
}

// Build the ReactFlow edge array. Parallel edges animate, carry a "parallel"
// label, and use the cyan accent; sequence edges are solid grey.
function toReactEdges(graph) {
  return (graph.edges || []).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    animated: edge.kind === "parallel" || edge.kind === "automatic",
    label: edge.label || (edge.kind === "parallel" ? "parallel" : undefined),
    type: edge.type || "smoothstep",
    style: {
      stroke: edge.style?.stroke || (
        edge.kind === "parallel" ? "#0ea5e9" :
        edge.kind === "automatic" ? "#0f766e" :
        edge.kind === "blocked" ? "#dc2626" :
        edge.kind === "policy" ? "#7c3aed" :
        edge.kind === "human" ? "#2563eb" :
        edge.kind === "agent" ? "#9333ea" :
        "#637083"
      ),
      strokeDasharray: edge.style?.strokeDasharray || (
        edge.kind === "automatic" ? "6 4" :
        edge.kind === "blocked" ? "3 4" :
        edge.kind === "policy" ? "8 5" :
        undefined
      )
    },
    labelStyle: edge.labelStyle || (edge.kind === "blocked" ? { fill: "#b91c1c", fontWeight: 700 } : undefined)
  }));
}

export function WorkflowGraph({ graph, fitSignal = 0 }) {
  const instanceRef = useRef(null);
  const positions = layoutGraph(graph);
  const nodes = toReactNodes(graph || {}, positions);
  const edges = toReactEdges(graph || {});
  const sideNodes = graph?.sideNodes || [];
  const graphHeight = graph?.height || 480;
  const memoNodeTypes = useMemo(() => nodeTypes, []);

  const onInit = useCallback((instance) => {
    instanceRef.current = instance;
    setTimeout(() => instance.fitView({ padding: 0.2 }), 0);
  }, []);

  // The "Fit view" button lives in the parent header; it bumps `fitSignal`,
  // which we react to here so we don't reach across the DOM like the legacy did.
  const lastFit = useRef(fitSignal);
  if (fitSignal !== lastFit.current) {
    lastFit.current = fitSignal;
    instanceRef.current?.fitView({ padding: 0.2, duration: 400 });
  }

  if (!nodes.length) {
    return <p className="muted">No graph nodes derived from source.</p>;
  }

  const sideOpen =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(min-width: 901px)").matches;

  return (
    <div className="workflow-graph-canvas" style={{ height: graphHeight }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={memoNodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          onInit={onInit}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} color="#d9e0ea" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </ReactFlowProvider>
      {sideNodes.length ? (
        <details className="workflow-graph-side" open={sideOpen}>
          <summary className="workflow-graph-side-summary">Run details</summary>
          <strong>Required by workflow</strong>
          <ul>
            {sideNodes.map((node) => (
              <li key={node.id} className={`graph-side-pill graph-side-${node.kind}`}>{node.label}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
