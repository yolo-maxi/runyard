import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const WORKFLOW_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

export function workflowTemplatesDir(root) {
  return path.resolve(root, "workflow-templates", "workflows");
}

// Resolve a registered capability to a checked-in workflow template. We only
// use sanitized basenames from workflow.entry/path, then fall back to <slug>.*.
export function loadWorkflowSource(capability, { root = process.cwd() } = {}) {
  const templatesDir = workflowTemplatesDir(root);
  for (const candidate of workflowSourceCandidates(capability)) {
    const absolute = path.resolve(templatesDir, candidate);
    if (!absolute.startsWith(templatesDir + path.sep)) continue;
    if (!existsSync(absolute)) continue;
    const code = readFileSync(absolute, "utf8");
    const ext = path.extname(absolute).slice(1).toLowerCase();
    return {
      absolutePath: absolute,
      relativePath: path.relative(root, absolute),
      language: ext || "txt",
      code
    };
  }
  return null;
}

export function workflowSourceCandidates(capability) {
  const slug = String(capability?.slug || "").trim();
  const candidates = [];
  const entry = capability?.workflow?.entry || capability?.workflow?.path || "";
  if (typeof entry === "string" && entry.trim()) {
    const safeBase = path.basename(entry.trim());
    if (/^[A-Za-z0-9_.-]+$/.test(safeBase)) candidates.push(safeBase);
    const slugFromEntry = safeBase.replace(/\.(tsx|jsx|ts|js)$/i, "");
    if (slugFromEntry && /^[A-Za-z0-9_.-]+$/.test(slugFromEntry)) {
      for (const ext of WORKFLOW_EXTENSIONS) candidates.push(`${slugFromEntry}${ext}`);
    }
  }
  if (slug && /^[A-Za-z0-9_-]+$/.test(slug)) {
    for (const ext of WORKFLOW_EXTENSIONS) candidates.push(`${slug}${ext}`);
  }
  return Array.from(new Set(candidates));
}

// Header tags such as `// smithers-display-name: Hello` annotate templates.
// Only the leading comment block is parsed, so body comments cannot mutate
// display metadata.
export function parseWorkflowMetadata(code) {
  const out = {};
  const lines = String(code || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("//")) {
      const match = line.match(/^\/\/\s*smithers-([a-z][a-z0-9-]*)\s*:\s*(.*)$/i);
      if (match) out[camelCase(match[1])] = match[2].trim();
      continue;
    }
    if (line.startsWith("/*") || line.startsWith("/**") || line.startsWith("*")) continue;
    break;
  }
  return out;
}

export function sliceWorkflowSections(code) {
  const lines = String(code || "").split(/\r?\n/);
  return {
    code: { startLine: 1, endLine: lines.length, text: code },
    agents: collectLineRanges(lines, [
      /\bnew\s+ClaudeCodeAgent\b/,
      /\bnew\s+CodexCLIAgent\b/,
      /\bnew\s+[A-Z][A-Za-z0-9_]*Agent\b/,
      /\bagent\s*[:=]/,
      /providers\.[a-z]+/
    ]),
    workflowGraph: collectLineRanges(lines, [
      /<Workflow\b/,
      /<\/Workflow>/,
      /<Sequence\b/,
      /<\/Sequence>/,
      /<Parallel\b/,
      /<\/Parallel>/,
      /<Task\b/,
      /<\/Task>/,
      /<Loop\b/,
      /<\/Loop>/
    ])
  };
}

const TASK_ID_RE = /<Task\b[^>]*?\bid=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\}|`([^`]+)`)/;
const TASK_AGENT_RE = /\bagent=\{([A-Za-z0-9_.()\s,]+)\}/;
const TASK_OUTPUT_RE = /\boutput=\{([A-Za-z0-9_.\s,]+)\}/;
const TASK_RETRIES_RE = /\bretries=\{(\d+)\}/;
const TASK_TIMEOUT_RE = /\btimeoutMs=\{([^}]+)\}/;
const KEYWORDS = {
  build: /\bpnpm[\s,]*\[?\s*['"]build['"]|\bbuild\b/i,
  commit: /\bgit[^"]*commit\b|\bcommit\b.*hash/i,
  push: /\bgit push\b|\bpush\b.*origin/i,
  test: /\bpnpm[\s,]*\[?\s*['"]test['"]|\bpnpm test\b|\btest\b.*passed/i
};

// Walk JSX once, tracking Sequence/Parallel containers. The returned graph is
// the shared shape for ReactFlow and the plain SVG fallback.
export function deriveWorkflowGraph(code, capability = {}) {
  const lines = String(code || "").split(/\r?\n/);
  const stack = [];
  const containers = [];
  const tasks = [];
  let workflowName = capability?.name || "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const wfOpen = line.match(/<Workflow\b[^>]*\bname=(?:"([^"]+)"|\{`([^`]+)`\})/);
    if (wfOpen) workflowName = wfOpen[1] || wfOpen[2] || workflowName;
    if (/<Sequence\b/.test(line)) pushContainer(stack, containers, { kind: "sequence", line: i + 1 });
    if (/<Parallel\b/.test(line)) {
      pushContainer(stack, containers, {
        kind: "parallel",
        line: i + 1,
        concurrency: (line.match(/maxConcurrency=\{?([^},\s>]+)\}?/) || [])[1] || ""
      });
    }
    if (/<\/Parallel>/.test(line) || /<\/Sequence>/.test(line)) stack.pop();

    const task = taskFromLine(lines, i, stack[stack.length - 1] || null, tasks.length);
    if (task) tasks.push(task);
  }

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

function camelCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function collectLineRanges(lines, patterns) {
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (patterns.some((re) => re.test(lines[i]))) hits.push(i);
  }
  if (!hits.length) return { startLine: 0, endLine: 0, text: "" };

  const spans = [];
  for (const index of hits) {
    const last = spans[spans.length - 1];
    if (last && index - last.end <= 2) last.end = index;
    else spans.push({ start: index, end: index });
  }
  return {
    startLine: spans[0].start + 1,
    endLine: spans[spans.length - 1].end + 1,
    text: spans.map((span) => formatLineSpan(lines, span)).join("\n\n")
  };
}

function formatLineSpan(lines, { start, end }) {
  const from = Math.max(0, start - 1);
  const to = Math.min(lines.length - 1, end + 1);
  return `// L${from + 1}-${to + 1}\n${lines.slice(from, to + 1).join("\n")}`;
}

function pushContainer(stack, containers, container) {
  const idPrefix = container.kind === "parallel" ? "par" : "seq";
  const next = { ...container, id: `${idPrefix}-${containers.length + 1}` };
  containers.push(next);
  stack.push(next);
}

function taskFromLine(lines, index, container, count) {
  const line = lines[index];
  const taskMatch = line.match(TASK_ID_RE);
  if (!taskMatch) return null;
  const rawId = taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4] || `task-${count + 1}`;
  const id = rawId.replace(/\$\{[^}]+\}/g, "N").replace(/\s+/g, "");
  const block = readTaskBlock(lines, index);
  return {
    id,
    line: index + 1,
    agent: pickAgent(line),
    output: (line.match(TASK_OUTPUT_RE) || [])[1] || "",
    retries: (line.match(TASK_RETRIES_RE) || [])[1] || "",
    timeout: (line.match(TASK_TIMEOUT_RE) || [])[1] || "",
    container,
    kind: classifyTask(id, block)
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

function taskNode(task) {
  return {
    id: task.id,
    type: task.kind,
    label: task.id,
    kind: task.kind,
    agent: task.agent,
    output: task.output,
    retries: task.retries,
    timeout: task.timeout,
    line: task.line,
    sublabel: taskSublabel(task)
  };
}

function capabilitySideNodes(capability) {
  return [
    ...(capability?.requiredAgents || []).map((agent) => ({ id: `agent:${agent}`, type: "agent", label: agent, kind: "agent" })),
    ...(capability?.requiredSkills || []).map((skill) => ({ id: `skill:${skill}`, type: "skill", label: skill, kind: "skill" })),
    ...(capability?.requiredRunnerTags || []).map((tag) => ({ id: `tag:${tag}`, type: "tag", label: tag, kind: "tag" }))
  ];
}

function pickAgent(line) {
  const match = line.match(TASK_AGENT_RE);
  return match ? match[1].trim().replace(/\s+/g, " ") : "";
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

function readTaskBlock(lines, startIndex) {
  let depth = 0;
  const out = [];
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 60); i += 1) {
    const line = lines[i];
    out.push(line);
    if (/<Task\b/.test(line)) depth += 1;
    if (/<\/Task>/.test(line) || (/\/>\s*$/.test(line) && depth > 0)) depth -= 1;
    if (depth <= 0 && out.length > 1) break;
  }
  return out.join("\n");
}

function classifyTask(id, block) {
  const idText = String(id || "").toLowerCase();
  if (/(^|[-_])approval|approvals?$/.test(idText)) return "approval";
  if (/(^|[-_])deploy|deploys?$/.test(idText)) return "deploy";
  if (/(^|[-_])(test|tests|verify|gate)$/.test(idText)) return "test";
  if (/(^|[-_])commit$/.test(idText)) return "commit";
  if (/(^|[-_])push$/.test(idText)) return "push";
  if (/(^|[-_])build$/.test(idText)) return "build";

  const text = String(block || "").toLowerCase();
  if (/\bapprovalkind|createapproval|requestapproval/.test(text)) return "approval";
  if (/\bsystemctl|caddy|reload|restart/.test(text)) return "deploy";
  if (KEYWORDS.test.test(text)) return "test";
  if (KEYWORDS.commit.test(text)) return "commit";
  if (KEYWORDS.push.test(text)) return "push";
  if (KEYWORDS.build.test(text)) return "build";
  if (/\bverif/.test(text)) return "verify";
  return "task";
}

function taskSublabel(task) {
  const bits = [];
  if (task.agent) bits.push(`agent ${task.agent}`);
  if (task.retries) bits.push(`retries=${task.retries}`);
  if (task.output) bits.push(`out=${task.output}`);
  if (task.container?.kind === "parallel") bits.push("parallel lane");
  return bits.join(" · ");
}
