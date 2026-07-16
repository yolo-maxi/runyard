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

export function scanWorkflowTasks(code, defaultName = "") {
  const lines = String(code || "").split(/\r?\n/);
  const stack = [];
  const containers = [];
  const tasks = [];
  let workflowName = defaultName;

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

  return { containers, tasks, workflowName };
}

export function taskNode(task) {
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
    containerKind: task.container?.kind || "",
    containerId: task.container?.id || "",
    sublabel: taskSublabel(task)
  };
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

function pickAgent(line) {
  const match = line.match(TASK_AGENT_RE);
  return match ? match[1].trim().replace(/\s+/g, " ") : "";
}

function readTaskBlock(lines, startIndex) {
  let depth = 0;
  const out = [];
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 60); i += 1) {
    const line = lines[i];
    out.push(line);
    if (/<Task\b/.test(line)) depth += 1;
    if (/<\/Task>/.test(line) || (/\/>\s*$/.test(line) && depth > 0)) depth -= 1;
    if (depth <= 0) break;
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
