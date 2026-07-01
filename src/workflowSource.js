import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
export {
  deriveWorkflowGraph,
  deriveWorkflowGraphFromMetadata
} from "./workflowGraph.js";

export const WORKFLOW_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

// Publish-time cap on workflow bundle size so oversized bundles fail fast at
// the capability publish boundary instead of tripping DB/RPC/transport blob
// ceilings at run time. Revisit if a legitimate workflow ever hits it.
export const MAX_WORKFLOW_BUNDLE_BYTES = 500 * 1024;

export function workflowBundleSizeError(source) {
  if (!source || source.sizeBytes <= MAX_WORKFLOW_BUNDLE_BYTES) return null;
  const where = source.relativePath ? ` (${source.relativePath})` : "";
  return `workflow bundle${where} is ${source.sizeBytes} bytes, which exceeds the 500 KB (${MAX_WORKFLOW_BUNDLE_BYTES} byte) workflow bundle limit`;
}

export function workflowTemplatesDir(root) {
  return path.resolve(root, "workflow-templates", "workflows");
}

// A capability opts into a DB-backed bundle by setting workflow.bundleId to a
// published workflow_bundles row id. Returns the trimmed id or null.
export function workflowBundleReference(capability) {
  const ref = capability?.workflow?.bundleId ?? capability?.workflow?.bundle_id ?? "";
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  return trimmed || null;
}

export function workflowSourceFromBundle(bundle) {
  return {
    bundleId: bundle.id,
    bundleVersion: bundle.version,
    sha256: bundle.sha256,
    relativePath: `db://workflow-bundles/${bundle.id}`,
    language: bundle.language || "txt",
    sizeBytes: bundle.sizeBytes,
    code: bundle.code
  };
}

export function missingWorkflowBundleError(capability, bundleId) {
  const error = new Error(
    `capability ${capability?.slug || "unknown"} references workflow bundle ${bundleId}, which does not exist in the workflow bundle store; refusing to fall back to a workflow template file`
  );
  error.code = "workflow_bundle_missing";
  error.bundleId = bundleId;
  return error;
}

// Resolve a registered capability to its workflow source. A workflow.bundleId
// reference resolves ONLY from the DB bundle store (via the injected
// getWorkflowBundle) and throws if the bundle is missing — a configured DB
// bundle must never silently fall back to a checked-in file. Capabilities
// without a bundle reference keep resolving checked-in templates: sanitized
// basenames from workflow.entry/path, then <slug>.*.
export function loadWorkflowSource(capability, { root = process.cwd(), getWorkflowBundle = null } = {}) {
  const bundleId = workflowBundleReference(capability);
  if (bundleId) {
    const bundle = typeof getWorkflowBundle === "function" ? getWorkflowBundle(bundleId) : null;
    if (!bundle || typeof bundle.code !== "string") throw missingWorkflowBundleError(capability, bundleId);
    return workflowSourceFromBundle(bundle);
  }
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
      sizeBytes: Buffer.byteLength(code, "utf8"),
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
