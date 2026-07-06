// smithers-source: authored
// smithers-display-name: Workflow Doctor
// smithers-description: Diagnoses failed Smithers workflows from redacted Hub run evidence, proposes the smallest workflow-source fix, and optionally applies it behind capability approval.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent, CodexAgent, PiAgent } from "smithers-orchestrator";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod/v4";
import { syncWorkflowToWorkspace } from "./workflow-repair.js";
import { createAgentFallbackPair, resolveAgentCli } from "./agent-fallback.js";

const HUB_URL = String(process.env.RUN_KNOWLEDGE_HUB_URL || process.env.RUNYARD_HUB_URL || process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117").replace(/\/$/, "");
const HUB_TOKEN = process.env.RUN_KNOWLEDGE_HUB_TOKEN || process.env.RUNYARD_HUB_TOKEN || process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN || "";

const REDACTION_RULES = [
  { re: /(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(x-api-key\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(api[_-]?key\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(password\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(secret\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /(token\s*[:=]\s*)[^\s,"'`]+/gi, replace: "$1[redacted]" },
  { re: /\bshub_[A-Za-z0-9]+\b/g, replace: "shub_[redacted]" },
  { re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replace: "sk-[redacted]" },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, replace: "ghp_[redacted]" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+\b/g, replace: "[redacted-jwt]" },
  { re: /(?:^|[\s(["'`])\/(?:home|Users|var|tmp|etc|root)\/[^\s)"'`<>]+/g, replace: " [local-path]" }
];
const SECRET_FIELD_RE = /(token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|private[_-]?key)/i;
const FAILED_STATUSES = new Set(["failed", "error", "errored", "cancelled", "rejected"]);
const WORKFLOW_SLUG_RE = /^[a-zA-Z0-9_.-]+$/;

const inputSchema = z.object({
  targetWorkflow: z.string().min(1).describe("Workflow/capability slug to diagnose."),
  lookbackHours: z.number().min(1).max(24 * 90).default(168).describe("How far back to sample runs."),
  count: z.number().int().min(1).max(50).default(20).describe("Maximum failed/error runs to inspect."),
  apply: z.boolean().default(false).describe("If true, apply the smallest deterministic fix to the target workflow file after approval."),
  focus: z.string().default("").describe("Optional diagnostic focus.")
});

const diagnosisSchema = z.looseObject({
  rootCause: z.string().default(""),
  failingNode: z.string().default(""),
  fixSummary: z.string().default(""),
  confidence: z.enum(["low", "medium", "high"]).default("low"),
  isDeterministic: z.boolean().default(false),
  proposedDiff: z.string().default("")
});

const evidenceSchema = z.looseObject({
  targetWorkflow: z.string(),
  workflowFile: z.string(),
  runsSampled: z.number().default(0),
  failedCount: z.number().default(0),
  topFingerprints: z.array(z.looseObject({ fingerprint: z.string(), count: z.number() })).default([]),
  failedRuns: z.array(z.looseObject({})).default([]),
  source: z.string().default("")
});

const applySchema = z.looseObject({
  applied: z.boolean().default(false),
  skippedReason: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  summary: z.string().default("")
});

const validateSchema = z.looseObject({
  graphOk: z.boolean().default(false),
  graphOutput: z.string().default(""),
  testResult: z.looseObject({
    command: z.string().default(""),
    passed: z.boolean().default(false),
    skipped: z.boolean().default(false),
    tail: z.string().default("")
  }).default({})
});

const resultSchema = z.looseObject({
  diagnosis: diagnosisSchema,
  evidence: z.looseObject({
    runsSampled: z.number().default(0),
    failedCount: z.number().default(0),
    topFingerprints: z.array(z.looseObject({ fingerprint: z.string(), count: z.number() })).default([])
  }),
  proposedDiff: z.string().default(""),
  applied: z.boolean().default(false),
  graphOk: z.boolean().default(false),
  testResult: z.looseObject({}).default({})
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  evidence: evidenceSchema,
  diagnose: diagnosisSchema,
  applyFix: applySchema,
  validate: validateSchema,
  result: resultSchema
});

const diagnostician = createAgentFallbackPair({
  ClaudeCodeAgent,
  CodexAgent,
  PiAgent,
  primaryCli: resolveAgentCli(process.env, { workflow: "WORKFLOW_DOCTOR", fallback: "claude" }),
  workflow: "WORKFLOW_DOCTOR",
  label: "workflow-doctor-diagnose",
  cwd: process.cwd(),
  claude: {
    model: process.env.RUNYARD_WORKFLOW_DOCTOR_CLAUDE_MODEL || "claude-sonnet-4-6",
    systemPrompt:
    "You diagnose Smithers workflow failures from supplied redacted evidence and source. " +
    "Distinguish deterministic workflow-code bugs from transient infrastructure/model/network failures. " +
    "When a code fix is appropriate, propose the smallest correct unified diff for only the target workflow file. Return JSON only."
  },
  codex: {
    ...(process.env.RUNYARD_WORKFLOW_DOCTOR_CODEX_MODEL ? { model: process.env.RUNYARD_WORKFLOW_DOCTOR_CODEX_MODEL } : {}),
    sandbox: "read-only"
  }
});

function createFixer(repoRoot: string) {
  return createAgentFallbackPair({
    ClaudeCodeAgent,
    CodexAgent,
    PiAgent,
    primaryCli: resolveAgentCli(process.env, { workflow: "WORKFLOW_DOCTOR", fallback: "claude" }),
    workflow: "WORKFLOW_DOCTOR",
    label: "workflow-doctor-fix",
    cwd: repoRoot,
    claude: {
      model: process.env.RUNYARD_WORKFLOW_DOCTOR_FIX_CLAUDE_MODEL || "claude-opus-4-7",
      dangerouslySkipPermissions: true,
      timeoutMs: 30 * 60 * 1000,
      systemPrompt:
      "You are repairing one Smithers workflow source file. Edit ONLY the target workflow file named in the prompt. " +
      "Make the smallest deterministic fix supported by the supplied diagnosis. Do not commit, push, deploy, or edit unrelated files."
    },
    codex: {
      ...(process.env.RUNYARD_WORKFLOW_DOCTOR_FIX_CODEX_MODEL ? { model: process.env.RUNYARD_WORKFLOW_DOCTOR_FIX_CODEX_MODEL } : {}),
      sandbox: "danger-full-access"
    }
  });
}

function redactText(value: unknown, max = 1000) {
  let text = String(value ?? "");
  for (const { re, replace } of REDACTION_RULES) text = text.replace(re, replace);
  text = text.replace(/\s+$/g, "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}...`;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value, 900);
  if (depth >= 3) return "[nested value]";
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      output[key] = SECRET_FIELD_RE.test(key) ? "[redacted]" : sanitize(item, depth + 1);
    }
    return output;
  }
  return redactText(value);
}

function inputText(value: unknown) {
  return String(value || "").trim();
}

function tail(text: string, lines = 120, max = 9000) {
  return redactText(String(text || "").split(/\r?\n/).slice(-lines).join("\n"), max);
}

function coerceJson(value: any) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  let text = value.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function safeWorkflowFile(slug: string) {
  const clean = inputText(slug);
  if (!WORKFLOW_SLUG_RE.test(clean) || clean.includes("..") || clean.includes("/") || clean.includes("\\")) {
    throw new Error(`Invalid targetWorkflow '${redactText(clean, 120)}'. Use a single capability/workflow slug.`);
  }
  return clean.endsWith(".tsx") ? clean : `${clean}.tsx`;
}

function resolveRepoRoot() {
  const configured =
    process.env.WORKFLOW_DOCTOR_REPO_DIR ||
    process.env.RUNYARD_REPAIR_REPO_DIR ||
    process.env.SMITHERS_HUB_ROOT ||
    process.env.IMPROVE_REPO_DIR ||
    process.env.GATED_REPO_DIR ||
    "";
  const candidates = [configured, "/home/xiko/smithers-hub", process.cwd()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: candidate,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const real = realpathSync(root);
      if (existsSync(path.join(real, "workflow-templates", "workflows")) && existsSync(path.join(real, "src", "seeds.js"))) {
        return real;
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("Workflow Doctor could not resolve the Smithers Hub repo root. Set WORKFLOW_DOCTOR_REPO_DIR=/abs/path/to/smithers-hub on the runner.");
}

function normalizeFingerprint(value: unknown) {
  return redactText(value, 600)
    .toLowerCase()
    .replace(/\b(run|appr|tok|art)_[a-z0-9]+\b/g, "$1_[id]")
    .replace(/\brun-\d+\b/g, "run-[id]")
    .replace(/\b[0-9a-f]{7,40}\b/g, "[sha]")
    .replace(/\d{2,}/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 220)
    .trim() || "unknown-error";
}

function failedNodeIds(diagnostics: any, logs: string) {
  const ids = new Set<string>();
  const visit = (value: any, depth = 0) => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    if (typeof value === "object") {
      const status = String(value.status || value.state || "").toLowerCase();
      const id = value.nodeId || value.node_id || value.id || value.name;
      if (id && /fail|error|cancel/.test(status)) ids.add(redactText(id, 120));
      Object.values(value).forEach((item) => visit(item, depth + 1));
    }
  };
  visit(diagnostics);
  for (const match of String(logs || "").matchAll(/\b(?:node|task)\s+([a-zA-Z0-9_.-]+)\s+(?:failed|errored|error)/gi)) {
    ids.add(redactText(match[1], 120));
  }
  return [...ids].slice(0, 8);
}

async function hubJson(pathname: string) {
  if (!HUB_TOKEN) throw new Error("Workflow Doctor needs RUNYARD_HUB_TOKEN (or legacy SMITHERS_HUB_TOKEN / RUN_KNOWLEDGE_HUB_TOKEN) on the runner.");
  const response = await fetch(`${HUB_URL}${pathname}`, {
    headers: { authorization: `Bearer ${HUB_TOKEN}`, "content-type": "application/json" }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Hub API ${pathname} failed with HTTP ${response.status}: ${redactText(text, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function hubText(pathname: string, cap = 12000) {
  if (!HUB_TOKEN) throw new Error("Workflow Doctor needs RUNYARD_HUB_TOKEN (or legacy SMITHERS_HUB_TOKEN / RUN_KNOWLEDGE_HUB_TOKEN) on the runner.");
  const response = await fetch(`${HUB_URL}${pathname}`, { headers: { authorization: `Bearer ${HUB_TOKEN}` } });
  const text = await response.text();
  if (!response.ok) return "";
  return redactText(text, cap);
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 5 * 60 * 1000) {
  return import("node:child_process").then(({ spawnSync }) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, PATH: [process.env.PATH || "", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":") },
      maxBuffer: 1024 * 1024 * 32
    });
    const combined = `${result.stdout || ""}${result.stderr || ""}${result.error?.message || ""}`;
    return { status: result.status ?? (result.error ? 1 : 0), output: tail(combined, 80, 12000) };
  });
}

export default smithers((ctx) => {
  const evidence = ctx.outputMaybe("evidence", { nodeId: "evidence" });
  const rawDiagnosis = ctx.outputMaybe("diagnose", { nodeId: "diagnose" });
  const diagnosis = rawDiagnosis ? coerceJson(rawDiagnosis) : null;
  const applied = ctx.outputMaybe("applyFix", { nodeId: "applyFix" });
  const validated = ctx.outputMaybe("validate", { nodeId: "validate" });
  const repoRoot = resolveRepoRoot();
  const workspaceDir = process.env.SMITHERS_WORKSPACE || process.cwd();
  const fixer = createFixer(repoRoot);

  return (
    <Workflow name="workflow-doctor">
      <Sequence>
        <Task id="evidence" output={outputs.evidence} retries={0}>
          {async () => {
            const file = safeWorkflowFile(ctx.input.targetWorkflow);
            const sourcePath = path.join(repoRoot, "workflow-templates", "workflows", file);
            if (!existsSync(sourcePath)) throw new Error(`Target workflow source not found: workflow-templates/workflows/${file}`);

            const count = Math.max(1, Math.min(Number(ctx.input.count || 20), 50));
            const lookbackHours = Math.max(1, Math.min(Number(ctx.input.lookbackHours || 168), 24 * 90));
            const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
            const query = new URLSearchParams({ limit: "500", capability: ctx.input.targetWorkflow });
            const data = await hubJson(`/api/runs?${query.toString()}`);
            const failed = (data.runs || [])
              .filter((run: any) => FAILED_STATUSES.has(String(run.status || "").toLowerCase()))
              .filter((run: any) => !run.createdAt || Date.parse(run.createdAt) >= cutoff)
              .slice(0, count);

            const failedRuns = [];
            const fingerprints: Record<string, number> = {};
            for (const run of failed) {
              const [diag, logs] = await Promise.all([
                hubJson(`/api/runs/${encodeURIComponent(run.id)}/diagnostics`).catch(() => ({ diagnostics: null })),
                hubText(`/api/runs/${encodeURIComponent(run.id)}/logs`, 16000).catch(() => "")
              ]);
              const diagnostics = sanitize(diag?.diagnostics || null);
              const errorText = run.error || run.reasonHint || run.currentStep || logs;
              const fingerprint = normalizeFingerprint(errorText);
              fingerprints[fingerprint] = (fingerprints[fingerprint] || 0) + 1;
              failedRuns.push({
                id: redactText(run.id || "", 120),
                status: redactText(run.status || "", 80),
                createdAt: run.createdAt || "",
                completedAt: run.completedAt || "",
                title: redactText(run.title || "", 220),
                reasonHint: redactText(run.reasonHint || "", 320),
                currentStep: redactText(run.currentStep || "", 220),
                fingerprint,
                failedNodeIds: failedNodeIds(diagnostics, logs),
                diagnostics,
                logTail: tail(logs)
              });
            }

            const topFingerprints = Object.entries(fingerprints)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([fingerprint, count]) => ({ fingerprint, count }));

            return {
              targetWorkflow: ctx.input.targetWorkflow,
              workflowFile: `workflow-templates/workflows/${file}`,
              runsSampled: failed.length,
              failedCount: failed.length,
              topFingerprints,
              failedRuns,
              source: redactText(readFileSync(sourcePath, "utf8"), 70000)
            };
          }}
        </Task>

        {evidence && (
          <Task id="diagnose" output={outputs.diagnose} agent={diagnostician} timeoutMs={12 * 60 * 1000}>
            {`Diagnose this Smithers workflow failure pattern and return ONLY JSON:
{
  "rootCause": "specific root cause, or transient/insufficient evidence",
  "failingNode": "node id if known, else empty string",
  "fixSummary": "smallest correct fix, or 'no code fix'",
  "confidence": "low|medium|high",
  "isDeterministic": true,
  "proposedDiff": "unified diff preview for ${evidence.workflowFile}, or empty string"
}

Rules:
- Use only this redacted evidence and source.
- If failures look transient/infra/model/network/token/capacity related, set isDeterministic=false and proposedDiff="".
- If evidence is insufficient, set confidence="low" and do not invent a fix.
- Proposed diff must touch ONLY ${evidence.workflowFile}.
- Focus: ${inputText(ctx.input.focus) || "root cause and smallest workflow-source fix"}.

Evidence and source:
${JSON.stringify(evidence, null, 2).slice(0, 150000)}`}
          </Task>
        )}

        {evidence && diagnosis && (
          <Task id="applyFix" output={outputs.applyFix} agent={ctx.input.apply && diagnosis.isDeterministic && diagnosis.confidence !== "low" ? fixer : undefined} timeoutMs={30 * 60 * 1000}>
            {ctx.input.apply && diagnosis.isDeterministic && diagnosis.confidence !== "low"
              ? `Apply the smallest fix to ${evidence.workflowFile} only.

Diagnosis:
${JSON.stringify(diagnosis, null, 2)}

Do not edit any other file. Do not commit, push, deploy, or run tests. Return JSON {"applied":true,"summary":"...","changedFiles":["${evidence.workflowFile}"]}.`
              : async () => ({
                  applied: false,
                  skippedReason: ctx.input.apply
                    ? "Skipped: diagnosis was not a medium/high confidence deterministic code bug."
                    : "Skipped: apply=false; diagnose-only mode.",
                  changedFiles: [],
                  summary: ""
                })}
          </Task>
        )}

        {evidence && applied && (
          <Task id="validate" output={outputs.validate} retries={0}>
            {async () => {
              if (!applied.applied) {
                return {
                  graphOk: false,
                  graphOutput: "Skipped: no file edits were applied.",
                  testResult: { command: "", passed: false, skipped: true, tail: "Skipped: no file edits were applied." }
                };
              }
              const { execFileSync } = await import("node:child_process");
              const changed = execFileSync("git", ["diff", "--name-only"], { cwd: repoRoot, encoding: "utf8" })
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
              const allowed = evidence.workflowFile;
              const unexpected = changed.filter((file) => file !== allowed);
              if (unexpected.length) throw new Error(`Workflow Doctor changed files outside ${allowed}: ${unexpected.join(", ")}`);

              const sync = syncWorkflowToWorkspace({
                repoRoot,
                workspaceDir,
                entry: `.smithers/workflows/${path.basename(evidence.workflowFile)}`,
                slug: ctx.input.targetWorkflow
              });
              if (!sync.ok) {
                return {
                  graphOk: false,
                  graphOutput: `Failed to sync workflow into Smithers workspace: ${sync.error || "unknown error"}`,
                  testResult: { command: "pnpm test", passed: false, skipped: true, tail: "Skipped because workspace sync failed." }
                };
              }
              const graphEntry = path.join(".smithers", "workflows", path.basename(evidence.workflowFile));
              const graph = await runCommand("npx", ["smithers", "graph", graphEntry], workspaceDir);
              const graphOk = graph.status === 0;
              if (!graphOk) {
                return {
                  graphOk,
                  graphOutput: graph.output,
                  testResult: { command: "pnpm test", passed: false, skipped: true, tail: "Skipped because graph validation failed." }
                };
              }

              const pkgPath = path.join(repoRoot, "package.json");
              const hasTest = existsSync(pkgPath) && Boolean(JSON.parse(readFileSync(pkgPath, "utf8")).scripts?.test);
              if (!hasTest) {
                return {
                  graphOk,
                  graphOutput: graph.output,
                  testResult: { command: "pnpm test", passed: true, skipped: true, tail: "Skipped: package.json has no test script." }
                };
              }
              const test = await runCommand("pnpm", ["test"], repoRoot, 20 * 60 * 1000);
              if (test.status !== 0) throw new Error(`pnpm test failed after workflow fix.\n${test.output}`);
              return {
                graphOk,
                graphOutput: graph.output,
                testResult: { command: "pnpm test", passed: true, skipped: false, tail: test.output }
              };
            }}
          </Task>
        )}

        {evidence && diagnosis && applied && validated && (
          <Task id="result" output={outputs.result} retries={0}>
            {async () => ({
              diagnosis,
              evidence: {
                runsSampled: evidence.runsSampled,
                failedCount: evidence.failedCount,
                topFingerprints: evidence.topFingerprints
              },
              proposedDiff: diagnosis.proposedDiff || "",
              applied: Boolean(applied.applied),
              graphOk: Boolean(validated.graphOk),
              testResult: validated.testResult || {}
            })}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
