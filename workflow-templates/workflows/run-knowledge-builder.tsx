// smithers-source: authored
// smithers-display-name: Run Knowledge Builder
// smithers-description: Reads recent Smithers Hub runs, redacts run evidence, and produces recommendation-only lessons and improvement ideas as a Markdown report.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent, CodexAgent, PiAgent } from "smithers-orchestrator";
import { z } from "zod/v4";
import { createAgentFallbackPair, resolveAgentCli } from "./agent-fallback.js";

const DEFAULT_STATUSES = ["succeeded", "failed", "cancelled", "waiting_approval", "error", "rejected"];
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

const inputSchema = z.object({
  capabilitySlug: z.string().default("").describe("Optional capability/workflow slug to focus on."),
  status: z.string().default("").describe("Optional comma-separated statuses to include."),
  lookbackHours: z.number().min(1).max(24 * 90).default(168).describe("How far back to sample runs."),
  count: z.number().int().min(1).max(50).default(20).describe("Maximum runs to inspect."),
  focusArea: z.string().default("").describe("Optional focus such as failures, approvals, artifacts, runner reliability, or prompt quality.")
});

const runEvidenceSchema = z.looseObject({
  id: z.string(),
  deepLink: z.string().default(""),
  capabilitySlug: z.string().default(""),
  capabilityName: z.string().default(""),
  status: z.string(),
  title: z.string().default(""),
  description: z.string().default(""),
  createdAt: z.string().default(""),
  completedAt: z.string().default(""),
  durationMs: z.number().nullable().default(null),
  reasonHint: z.string().default(""),
  currentStep: z.string().default(""),
  diagnostics: z.unknown().nullable().default(null),
  logTail: z.string().default(""),
  artifacts: z.array(z.looseObject({ name: z.string(), mimeType: z.string().default(""), sizeBytes: z.number().default(0), deepLink: z.string().default("") })).default([])
});

const gatherSchema = z.looseObject({
  filters: z.looseObject({}),
  totalCandidates: z.number().default(0),
  sampledRuns: z.array(runEvidenceSchema).default([]),
  statusCounts: z.record(z.string(), z.number()).default({}),
  capabilityCounts: z.record(z.string(), z.number()).default({}),
  knowledgeResources: z.array(z.looseObject({ slug: z.string(), title: z.string(), tags: z.array(z.string()).default([]) })).default([]),
  evidenceNotes: z.array(z.string()).default([])
});

const recommendationSchema = z.looseObject({
  title: z.string().default(""),
  action: z.string().default(""),
  confidence: z.enum(["low", "medium", "high"]).default("low"),
  evidence: z.array(z.string()).default([]),
  inference: z.string().default(""),
  approvalRequired: z.boolean().default(true)
});

const analysisSchema = z.looseObject({
  runSampleSummary: z.string().default(""),
  recurringFailureModes: z.array(recommendationSchema).default([]),
  reusableLessons: z.array(recommendationSchema).default([]),
  suggestedSkillUpdates: z.array(recommendationSchema).default([]),
  suggestedAgentInstructionUpdates: z.array(recommendationSchema).default([]),
  suggestedWorkflowTemplateImprovements: z.array(recommendationSchema).default([]),
  recommendedNextActions: z.array(recommendationSchema).default([])
});

const reportSchema = z.looseObject({
  artifactName: z.string().default("run-knowledge-report.md"),
  report: z.string(),
  runSampleSummary: z.string().default(""),
  recurringFailureModes: z.array(recommendationSchema).default([]),
  reusableLessons: z.array(recommendationSchema).default([]),
  suggestedSkillUpdates: z.array(recommendationSchema).default([]),
  suggestedAgentInstructionUpdates: z.array(recommendationSchema).default([]),
  suggestedWorkflowTemplateImprovements: z.array(recommendationSchema).default([]),
  recommendedNextActions: z.array(recommendationSchema).default([])
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  gather: gatherSchema,
  analyze: analysisSchema,
  report: reportSchema
});

const analyst = createAgentFallbackPair({
  ClaudeCodeAgent,
  CodexAgent,
  PiAgent,
  primaryCli: resolveAgentCli(process.env, { workflow: "KNOWLEDGE", fallback: "claude" }),
  workflow: "KNOWLEDGE",
  label: "run-knowledge-builder",
  cwd: "/tmp",
  claude: {
    model: process.env.RUNYARD_KNOWLEDGE_CLAUDE_MODEL || "claude-sonnet-4-6",
    systemPrompt:
    "You analyze Smithers Hub run evidence. Use only the supplied redacted evidence. " +
    "Separate evidence from inference, cite run ids or deep links, avoid generic advice, and recommend changes without mutating skills, agents, workflows, or knowledge resources."
  },
  codex: {
    ...(process.env.RUNYARD_KNOWLEDGE_CODEX_MODEL ? { model: process.env.RUNYARD_KNOWLEDGE_CODEX_MODEL } : {}),
    sandbox: "read-only"
  }
});

function redactText(value: unknown, max = 1000) {
  let text = String(value ?? "");
  for (const { re, replace } of REDACTION_RULES) text = text.replace(re, replace);
  text = text.replace(/\s+$/g, "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}...`;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value, 700);
  if (depth >= 3) return "[nested value]";
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      output[key] = SECRET_FIELD_RE.test(key) ? "[redacted]" : sanitize(item, depth + 1);
    }
    return output;
  }
  return redactText(value);
}

function csv(value: string) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function inputText(value: unknown) {
  return String(value || "").trim();
}

function absoluteDeepLink(link = "") {
  if (!link) return "";
  try {
    return new URL(link, HUB_URL).toString();
  } catch {
    return `${HUB_URL}${link.startsWith("/") ? "" : "/"}${link}`;
  }
}

async function hubJson(path: string) {
  if (!HUB_TOKEN) throw new Error("Run Knowledge Builder needs RUNYARD_HUB_TOKEN (or legacy SMITHERS_HUB_TOKEN / RUN_KNOWLEDGE_HUB_TOKEN) on the runner.");
  const response = await fetch(`${HUB_URL}${path}`, {
    headers: { authorization: `Bearer ${HUB_TOKEN}`, "content-type": "application/json" }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Hub API ${path} failed with HTTP ${response.status}: ${redactText(text, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function hubText(path: string, cap = 2000) {
  if (!HUB_TOKEN) throw new Error("Run Knowledge Builder needs RUNYARD_HUB_TOKEN (or legacy SMITHERS_HUB_TOKEN / RUN_KNOWLEDGE_HUB_TOKEN) on the runner.");
  const response = await fetch(`${HUB_URL}${path}`, {
    headers: { authorization: `Bearer ${HUB_TOKEN}` }
  });
  const text = await response.text();
  if (!response.ok) return "";
  return redactText(text, cap);
}

// Textual artifacts worth reading in full (diffs, reports, structured output,
// error traces) vs. opaque blobs we only describe by metadata.
const TEXTUAL_ARTIFACT_RE = /\.(md|markdown|txt|json|ndjson|log|diff|patch|csv|ya?ml|tsx?|jsx?|mjs|cjs|py|sh|html?)$/i;
const TEXTUAL_MIME_RE = /(text|json|markdown|xml|x-ndjson|javascript|typescript|yaml|csv|diff|patch)/i;
const ARTIFACT_CONTENT_PER = 2800;       // max redacted chars per artifact
const ARTIFACT_CONTENT_RUN_BUDGET = 9000; // max redacted chars of artifact content per run

// Rank the artifacts most likely to explain a run: the workflow's own output
// and any human-readable report/diff/error first; raw event streams last.
function artifactSignalScore(name = "") {
  const n = name.toLowerCase();
  if (/smithers-output\.json$/.test(n)) return 100;
  if (/report.*\.md$|\.md$/.test(n)) return 90;
  if (/\.(diff|patch)$/.test(n)) return 85;
  if (/error|fail|stderr|trace/.test(n)) return 80;
  if (/retrospective|summary|outcome/.test(n)) return 70;
  if (/\.json$/.test(n)) return 50;
  if (/events?\.ndjson$|smithers-events/.test(n)) return 10;
  return 40;
}

// Pull redacted content for the highest-signal textual artifacts. Spend the
// budget only where the signal is richest — failed/cancelled runs, or when the
// caller explicitly focuses on artifacts — so successful runs stay cheap.
async function enrichArtifacts(run: any, artifacts: any[], focusArea = "") {
  const status = String(run.status || "").toLowerCase();
  const failed = /fail|cancel|error|reject|timeout/.test(status);
  const artifactFocus = /artifact|output|diff|report/i.test(focusArea);
  if (!failed && !artifactFocus) return artifacts;
  let budget = ARTIFACT_CONTENT_RUN_BUDGET;
  const ranked = [...artifacts].sort((a, b) => artifactSignalScore(b?.name) - artifactSignalScore(a?.name));
  const out = [];
  for (const artifact of ranked) {
    const id = artifact?.id || artifact?.artifactId;
    const textual = TEXTUAL_ARTIFACT_RE.test(artifact?.name || "") || TEXTUAL_MIME_RE.test(artifact?.mimeType || "");
    if (budget > 0 && id && textual) {
      const raw = await hubText(`/api/artifacts/${encodeURIComponent(id)}/download`, ARTIFACT_CONTENT_PER).catch(() => "");
      if (raw) {
        const content = raw.length > budget ? `${raw.slice(0, budget)}...` : raw;
        budget -= content.length;
        out.push({ ...artifact, content });
        continue;
      }
    }
    out.push(artifact);
  }
  return out;
}

function countBy<T>(items: T[], getKey: (item: T) => string) {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = getKey(item) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function tail(text: string, lines = 120) {
  return redactText(String(text || "").split(/\r?\n/).slice(-lines).join("\n"), 8000);
}

function cleanRun(run: any, diagnostics: any, artifacts: any[], logs: string) {
  return {
    id: run.id,
    deepLink: absoluteDeepLink(run.deepLink || `/app#runs/${run.id}`),
    capabilitySlug: redactText(run.capabilitySlug || "", 120),
    capabilityName: redactText(run.capabilityName || "", 160),
    status: redactText(run.status || "", 80),
    title: redactText(run.title || "", 220),
    description: redactText(run.description || "", 320),
    createdAt: run.createdAt || "",
    completedAt: run.completedAt || "",
    durationMs: run.durationMs ?? null,
    reasonHint: redactText(run.reasonHint || "", 260),
    currentStep: redactText(run.currentStep || "", 220),
    diagnostics: sanitize(diagnostics),
    logTail: tail(logs),
    artifacts: artifacts.slice(0, 10).map((artifact) => ({
      name: redactText(artifact.name || "artifact", 180),
      mimeType: redactText(artifact.mimeType || "", 120),
      sizeBytes: Number(artifact.sizeBytes || 0),
      deepLink: absoluteDeepLink(artifact.deepLink || ""),
      ...(artifact.content ? { content: redactText(artifact.content, ARTIFACT_CONTENT_PER) } : {})
    }))
  };
}

function listItems(items: any[], empty: string) {
  if (!items?.length) return `- ${empty}`;
  return items
    .map((item) => {
      const title = item.title || item.action || "Recommendation";
      const action = item.action && item.action !== title ? `\n  - Action: ${item.action}` : "";
      const evidence = Array.isArray(item.evidence) && item.evidence.length ? `\n  - Evidence: ${item.evidence.join("; ")}` : "\n  - Evidence: not enough direct evidence";
      const inference = item.inference ? `\n  - Inference: ${item.inference}` : "\n  - Inference: none";
      const approval = item.approvalRequired === false ? "no" : "yes";
      return `- ${title}${action}\n  - Confidence: ${item.confidence || "low"}\n  - Approval required before mutation: ${approval}${evidence}${inference}`;
    })
    .join("\n");
}

function asList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// The analyst agent returns its findings as a JSON *string* (often wrapped in
// prose or ```json fences). Coerce it back to an object before rendering —
// without this, normalizeAnalysis reads every field off a string, gets
// `undefined`, and silently renders the all-empty "evidence too sparse"
// report even when the agent produced a rich, correct analysis.
function coerceAnalysis(value: any) {
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

function normalizeAnalysis(value: any) {
  return {
    runSampleSummary: inputText(value?.runSampleSummary) || "The sampled evidence was too small or sparse for a confident summary.",
    recurringFailureModes: asList(value?.recurringFailureModes),
    reusableLessons: asList(value?.reusableLessons),
    suggestedSkillUpdates: asList(value?.suggestedSkillUpdates),
    suggestedAgentInstructionUpdates: asList(value?.suggestedAgentInstructionUpdates),
    suggestedWorkflowTemplateImprovements: asList(value?.suggestedWorkflowTemplateImprovements),
    recommendedNextActions: asList(value?.recommendedNextActions)
  };
}

function renderReport(gather: any, analysis: any) {
  const filters = gather.filters || {};
  const sampledRuns = gather.sampledRuns || [];
  const sampleLines = sampledRuns.length
    ? sampledRuns
        .map((run: any) => `- [${run.id}](${run.deepLink}) ${run.status} ${run.capabilitySlug} - ${run.title || run.reasonHint || run.currentStep || "untitled"}`)
        .join("\n")
    : "- No matching runs were available in this sample.";
  const knowledge = gather.knowledgeResources?.length
    ? gather.knowledgeResources.map((item: any) => `- ${item.slug}: ${item.title}`).join("\n")
    : "- No matching knowledge resources were pulled into this run.";
  return `# Run Knowledge Report

Recommendation-only output. This run did not mutate live skills, agents, workflows, templates, or knowledge resources.

## Filters
- Capability: ${filters.capabilitySlug || "any"}
- Statuses: ${(filters.statuses || []).join(", ") || "default completed/waiting statuses"}
- Lookback hours: ${filters.lookbackHours}
- Requested count: ${filters.count}
- Focus area: ${filters.focusArea || "general run learning"}
- Candidate runs after filters: ${gather.totalCandidates}
- Sampled runs: ${sampledRuns.length}

## Run Sample Summary
${analysis.runSampleSummary || "No summary returned."}

## Evidence Sample
${sampleLines}

## Recurring Failure Modes
${listItems(analysis.recurringFailureModes || [], "No recurring failure mode was supported by this sample.")}

## Reusable Lessons
${listItems(analysis.reusableLessons || [], "No durable lesson was supported by this sample.")}

## Suggested Skill Updates
${listItems(analysis.suggestedSkillUpdates || [], "No skill update was supported by this sample.")}

## Suggested Agent Instruction Updates
${listItems(analysis.suggestedAgentInstructionUpdates || [], "No agent instruction update was supported by this sample.")}

## Suggested Workflow / Template Improvements
${listItems(analysis.suggestedWorkflowTemplateImprovements || [], "No workflow/template improvement was supported by this sample.")}

## Recommended Next Actions
${listItems(analysis.recommendedNextActions || [], "No next action was supported by this sample.")}

## Related Knowledge Resources
${knowledge}

## Evidence Notes
${(gather.evidenceNotes || []).map((note: string) => `- ${note}`).join("\n") || "- None."}
`;
}

export default smithers((ctx) => {
  const gathered = ctx.outputMaybe("gather", { nodeId: "gather" });
  const analyzed = ctx.outputMaybe("analyze", { nodeId: "analyze" });

  return (
    <Workflow name="run-knowledge-builder">
      <Sequence>
        <Task id="gather" output={outputs.gather} retries={0}>
          {async () => {
            const statuses = csv(ctx.input.status);
            const effectiveStatuses = statuses.length ? statuses : DEFAULT_STATUSES;
            const count = Math.max(1, Math.min(Number(ctx.input.count || 20), 50));
            const lookbackHours = Math.max(1, Math.min(Number(ctx.input.lookbackHours || 168), 24 * 90));
            const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
            const capabilitySlug = inputText(ctx.input.capabilitySlug);
            const query = new URLSearchParams({ limit: "500" });
            if (capabilitySlug) query.set("capability", capabilitySlug);
            const data = await hubJson(`/api/runs?${query.toString()}`);
            const allRuns = (data.runs || [])
              .filter((run: any) => effectiveStatuses.includes(run.status))
              .filter((run: any) => !run.createdAt || Date.parse(run.createdAt) >= cutoff)
              .slice(0, count);

            const focusArea = inputText(ctx.input.focusArea);
            const sampledRuns = [];
            for (const run of allRuns) {
              const [diag, artifactList, logs] = await Promise.all([
                hubJson(`/api/runs/${encodeURIComponent(run.id)}/diagnostics`).catch(() => ({ diagnostics: null })),
                hubJson(`/api/runs/${encodeURIComponent(run.id)}/artifacts`).catch(() => ({ artifacts: [] })),
                hubText(`/api/runs/${encodeURIComponent(run.id)}/logs`, 14000).catch(() => "")
              ]);
              const enriched = await enrichArtifacts(run, artifactList?.artifacts || [], focusArea);
              sampledRuns.push(cleanRun(run, diag?.diagnostics || null, enriched, logs));
            }

            const knowledgeQuery = focusArea || capabilitySlug || "run knowledge";
            const knowledge = await hubJson(`/api/knowledge?q=${encodeURIComponent(knowledgeQuery)}`).catch(() => ({ knowledge: [] }));
            return {
              filters: { capabilitySlug, statuses: effectiveStatuses, lookbackHours, count, focusArea },
              totalCandidates: allRuns.length,
              sampledRuns,
              statusCounts: countBy(sampledRuns, (run: any) => run.status),
              capabilityCounts: countBy(sampledRuns, (run: any) => run.capabilitySlug),
              knowledgeResources: (knowledge.knowledge || []).slice(0, 8).map((item: any) => ({
                slug: redactText(item.slug || "", 120),
                title: redactText(item.title || "", 180),
                tags: Array.isArray(item.tags) ? item.tags.map((tag: string) => redactText(tag, 80)) : []
              })),
              evidenceNotes: [
                "Run logs were pulled from the Hub redacted logs endpoint (up to ~120 lines / 8k chars per run).",
                "Redacted artifact contents (outputs, reports, diffs, error traces) were downloaded for failed/cancelled runs, budgeted per run.",
                "Secret-looking fields and local absolute paths were redacted before agent analysis."
              ]
            };
          }}
        </Task>

        {gathered && (
          <Task id="analyze" output={outputs.analyze} agent={analyst} timeoutMs={12 * 60 * 1000}>
            {`Analyze this redacted Smithers Hub run sample and return only JSON matching this shape:
{
  "runSampleSummary": "short evidence-grounded summary",
  "recurringFailureModes": [{"title","action","confidence":"low|medium|high","evidence":["run ids/deep links and exact observed signals"],"inference":"what you infer, if anything","approvalRequired":true}],
  "reusableLessons": [...],
  "suggestedSkillUpdates": [...],
  "suggestedAgentInstructionUpdates": [...],
  "suggestedWorkflowTemplateImprovements": [...],
  "recommendedNextActions": [...]
}

Rules:
- Use only supplied evidence. If the sample is small, say so and use low confidence.
- Put observed facts in evidence and interpretation in inference.
- Cite run ids or deep links for every non-empty recommendation.
- Avoid generic advice such as "add better logging" unless a concrete run signal supports it.
- This is recommendation-only. Do not claim any live mutation happened.
- Focus area: ${inputText(ctx.input.focusArea) || "general run learning"}.

Redacted run evidence:
${JSON.stringify(gathered, null, 2).slice(0, 150000)}`}
          </Task>
        )}

        {gathered && analyzed && (
          <Task id="report" output={outputs.report} retries={0}>
            {async () => {
              const normalized = normalizeAnalysis(coerceAnalysis(analyzed));
              return {
                artifactName: "run-knowledge-report.md",
                ...normalized,
                report: renderReport(gathered, normalized)
              };
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
