// smithers-source: authored
// smithers-display-name: Product Workflow (sequential)
// smithers-description: Sequential product-development pipeline for the Runyard app. Researches competitors and maps their features, synthesizes a feature map against Runyard, prioritizes the gaps, then dispatches one gated implementation per feature — strictly one at a time so no two builders ever touch the repo at once. Each implementation reuses the implement-change-gated contract (pnpm test, staged diff, sane commit, push to main). execute=false plans and reports the runs it would create; execute=true queues them and waits for each to finish before starting the next.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent } from "smithers-orchestrator";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { resolveImproveRepo } from "./improve-repo.js";

// The implementation step queues child Hub runs the same way run-smithers does,
// so it needs the Hub URL + token on the runner. Plan-only (execute=false) runs
// never call the Hub, so a missing token only blocks actual dispatch.
const HUB_URL = String(
  process.env.PRODUCT_WORKFLOW_HUB_URL ||
    process.env.SMITHERS_HUB_URL ||
    process.env.HUB_URL ||
    "http://127.0.0.1:43117"
).replace(/\/$/, "");
const HUB_TOKEN =
  process.env.PRODUCT_WORKFLOW_HUB_TOKEN ||
  process.env.SMITHERS_HUB_TOKEN ||
  process.env.HUB_TOKEN ||
  "";
const POLL_INTERVAL_MS = Number(process.env.PRODUCT_WORKFLOW_POLL_INTERVAL_MS || 5_000);
const POLL_DEADLINE_MS = Number(process.env.PRODUCT_WORKFLOW_POLL_DEADLINE_MS || 60 * 60 * 1000);

function resolveTool(envName, fallback, candidates) {
  const configured = process.env[envName];
  if (configured) return configured;
  return candidates.find((candidate) => existsSync(candidate)) || fallback;
}
const GIT = resolveTool("GATED_GIT_BIN", "git", ["/usr/bin/git", "/usr/local/bin/git"]);
const TOOL_PATH = [process.env.PATH || "", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");
const TOOL_ENV = { ...process.env, PATH: TOOL_PATH };

const baselineOut = z.looseObject({ startHead: z.string(), repoDir: z.string().default("") });

const competitorSchema = z.looseObject({
  name: z.string(),
  url: z.string().default(""),
  positioning: z.string().default(""),
  features: z.array(z.string()).default([]),
  notes: z.string().default("")
});
const researchOut = z.looseObject({
  summary: z.string().default(""),
  competitors: z.array(competitorSchema).default([]),
  sources: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([])
});

const mappedFeatureSchema = z.looseObject({
  name: z.string(),
  description: z.string().default(""),
  competitorsWithIt: z.array(z.string()).default([]),
  runyardHasIt: z.boolean().default(false),
  gap: z.string().default(""),
  valueRationale: z.string().default("")
});
const featureMapOut = z.looseObject({
  summary: z.string().default(""),
  features: z.array(mappedFeatureSchema).default([]),
  tableMarkdown: z.string().default("")
});

const prioritizedFeatureSchema = z.looseObject({
  rank: z.number().int().default(0),
  title: z.string(),
  priority: z.string().default(""),
  rationale: z.string().default(""),
  acceptanceCheck: z.string().default(""),
  workPrompt: z.string().default(""),
  commitMessage: z.string().default("")
});
const prioritizeOut = z.looseObject({
  summary: z.string().default(""),
  prioritizedFeatures: z.array(prioritizedFeatureSchema).default([]),
  deferred: z.array(z.string()).default([])
});

const dispatchedRunSchema = z.looseObject({
  rank: z.number().int().default(0),
  title: z.string().default(""),
  runId: z.string().default(""),
  status: z.string().default(""),
  commit: z.string().default(""),
  pushed: z.boolean().default(false),
  error: z.string().default(""),
  payload: z.looseObject({}).default({})
});
const dispatchOut = z.looseObject({
  executed: z.boolean().default(false),
  targetRepo: z.string().default(""),
  targetBranch: z.string().default("main"),
  pushedToMain: z.boolean().default(false),
  dispatched: z.array(dispatchedRunSchema).default([]),
  artifactName: z.string().default("product-workflow-report.md"),
  report: z.string().default(""),
  notes: z.string().default("")
});

const inputSchema = z.object({
  context: z
    .string()
    .default("")
    .describe("Optional product context: positioning, target users, known competitor names/URLs, or constraints to focus the research."),
  competitors: z
    .string()
    .default("")
    .describe("Optional comma- or newline-separated list of named competitors/products to map first."),
  maxCompetitors: z.number().int().min(1).max(12).default(5),
  maxFeatures: z.number().int().min(1).max(8).default(3).describe("How many prioritized features to (plan to) implement, in order."),
  execute: z
    .boolean()
    .default(false)
    .describe("If true, queue real gated implementation runs sequentially. If false (default), plan and report the runs that would be created."),
  deploy: z.boolean().default(false).describe("Forwarded to each implementation run: deploy to prod after its gates pass."),
  targetBranch: z.string().default("main").describe("Branch each implementation pushes to. Defaults to main per the product request."),
  repoDir: z
    .string()
    .default("")
    .describe("Absolute runner-local git repo path to inspect/build. Must be inside allowed improve repo roots. Defaults to the Runyard repo."),
  repo: z
    .string()
    .default("smithers-hub")
    .describe("Friendly repo key resolved on the runner from IMPROVE_REPO_MAP. Defaults to smithers-hub (Runyard)."),
  project: z.string().default("").describe("Optional friendly project key resolved from IMPROVE_PROJECT_MAP or IMPROVE_REPO_MAP.")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  baseline: baselineOut,
  research: researchOut,
  researchReady: researchOut,
  featureMap: featureMapOut,
  featureMapReady: featureMapOut,
  prioritize: prioritizeOut,
  prioritizeReady: prioritizeOut,
  dispatch: dispatchOut
});

function createResearcher(repoDir) {
  return new ClaudeCodeAgent({
    model: "claude-opus-4-7",
    cwd: repoDir,
    allowedTools: ["Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"],
    timeoutMs: 25 * 60 * 1000,
    systemPrompt:
      "You are a product researcher mapping the competitive landscape for the Runyard app (a self-hosted control plane, runner, CLI, and MCP server for agent runs). " +
      "Inspect Runyard's own current capabilities in this repository first (read code, seeds, docs) so you compare against what already exists. " +
      "Then identify the most relevant competing or adjacent products and map their notable features. " +
      "Prefer current primary sources, record URLs, and distinguish observed facts from inference. Do not invent features you cannot attribute. " +
      "Do NOT modify files; you are researching only. Return only the requested JSON."
  });
}

function createStrategist(repoDir) {
  return new ClaudeCodeAgent({
    model: "claude-opus-4-7",
    cwd: repoDir,
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    timeoutMs: 20 * 60 * 1000,
    systemPrompt:
      "You are a taste-led Product Manager for the Runyard app. Synthesize competitor research and the current codebase into a clear feature map, " +
      "then prioritize a small set of high-leverage features that fit Runyard's actual architecture and users. " +
      "Be ruthless about scope: every feature you prioritize must be buildable as one focused, gated change against this repository. " +
      "Write each feature as a self-contained implementation brief a coding agent can act on directly, with a verifiable acceptance check. " +
      "Do NOT modify files; you are planning only. Return only the requested JSON."
  });
}

function parseNamedList(raw) {
  return String(raw || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function hubJson(pathname, options = {}) {
  if (!HUB_TOKEN) {
    throw new Error(
      "product-workflow execute=true needs SMITHERS_HUB_TOKEN (or PRODUCT_WORKFLOW_HUB_TOKEN) on the runner to queue implementation runs."
    );
  }
  const response = await fetch(`${HUB_URL}${pathname}`, {
    method: options.method || "GET",
    headers: { authorization: `Bearer ${HUB_TOKEN}`, "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Hub ${options.method || "GET"} ${pathname} failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return text ? JSON.parse(text) : null;
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "rejected", "error"]);

async function pollRunToTerminal(runId) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    const detail = await hubJson(`/api/runs/${encodeURIComponent(runId)}`);
    const run = detail?.run;
    const status = String(run?.status || "");
    if (TERMINAL_STATUSES.has(status)) return run;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

// Build the implement-change-gated input for one prioritized feature. We forward
// the same repo selector the product workflow resolved, so every child run edits
// the same Runyard repo and pushes to the same branch.
function buildChildPayload(feature, input) {
  const payload = {
    workPrompt: feature.workPrompt || `Implement: ${feature.title}\n\nAcceptance: ${feature.acceptanceCheck || "(none provided)"}`,
    deploy: Boolean(input.deploy),
    targetBranch: input.targetBranch || "main",
    commitMessage: feature.commitMessage || `feat: ${String(feature.title || "feature").slice(0, 60)}`
  };
  if (String(input.repoDir || "").trim()) payload.repoDir = input.repoDir.trim();
  else if (String(input.project || "").trim()) payload.project = input.project.trim();
  else payload.repo = String(input.repo || "smithers-hub").trim() || "smithers-hub";
  return payload;
}

function renderReport(ctx, research, featureMap, prioritized, dispatched, executed) {
  const safeResearch = research || {};
  const competitors = arrayFromMaybeJson(safeResearch.competitors);
  const sources = arrayFromMaybeJson(safeResearch.sources);
  const safeFeatureMap = featureMap || {};
  const mappedFeatures = arrayFromMaybeJson(safeFeatureMap.features);
  const prioritizedFeatures = arrayFromMaybeJson(prioritized);
  const dispatchedRuns = arrayFromMaybeJson(dispatched);
  const lines = [];
  lines.push(`# Product Workflow — Runyard\n`);
  lines.push(`Mode: ${executed ? "EXECUTED (gated implementation runs queued sequentially)" : "PLAN ONLY (no runs created)"}`);
  lines.push(`Target repo selector: ${ctx.input.repoDir || ctx.input.project || ctx.input.repo || "smithers-hub"} → branch ${ctx.input.targetBranch || "main"}\n`);

  lines.push(`## Competitors mapped (${competitors.length})`);
  for (const c of competitors) {
    lines.push(`- **${c.name}**${c.url ? ` (${c.url})` : ""}${c.positioning ? ` — ${c.positioning}` : ""}`);
    if (c.features?.length) lines.push(`  - features: ${c.features.join("; ")}`);
  }
  if (sources.length) lines.push(`\nSources: ${sources.join(", ")}`);

  lines.push(`\n## Feature map (${mappedFeatures.length})`);
  if (safeFeatureMap.tableMarkdown) {
    lines.push(safeFeatureMap.tableMarkdown);
  } else {
    for (const f of mappedFeatures) {
      lines.push(`- **${f.name}** — Runyard has it: ${f.runyardHasIt ? "yes" : "no"}. ${f.gap || f.description || ""}`);
    }
  }

  lines.push(`\n## Prioritized features (${prioritizedFeatures.length})`);
  for (const f of prioritizedFeatures) {
    lines.push(`${f.rank || "?"}. **${f.title}** [${f.priority || "?"}] — ${f.rationale || ""}`);
    lines.push(`   - acceptance: ${f.acceptanceCheck || "(none)"}`);
  }

  lines.push(`\n## Implementation runs (${executed ? "created" : "would create"}) — sequential, one at a time`);
  if (!dispatchedRuns.length) {
    lines.push("(none)");
  } else {
    for (const d of dispatchedRuns) {
      const idPart = d.runId ? `run ${d.runId}` : "(not created — plan only)";
      lines.push(
        `${d.rank || "?"}. **${d.title}** → ${idPart}` +
          (d.status ? ` — status ${d.status}` : "") +
          (d.commit ? ` — commit ${d.commit}` : "") +
          (d.error ? ` — error: ${d.error}` : "")
      );
    }
  }
  lines.push(
    `\nSequential dispatch guarantees no two implementation builders edit ${
      ctx.input.repoDir || ctx.input.repo || "the Runyard repo"
    } at the same time, so prioritized features land on ${ctx.input.targetBranch || "main"} without merge conflicts.`
  );
  return lines.join("\n");
}

function arrayFromMaybeJson(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function objectFromMaybeJson(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const candidates = [text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return null;
}

function hasStructuredArray(stage, keys) {
  if (!stage || typeof stage !== "object") return false;
  return keys.some((key) => arrayFromMaybeJson(stage[key]).length > 0);
}

function smithersDbPath() {
  if (process.env.SMITHERS_DB) return process.env.SMITHERS_DB;
  if (process.env.SMITHERS_WORKSPACE) return path.join(process.env.SMITHERS_WORKSPACE, "smithers.db");
  return path.join(process.cwd(), "smithers.db");
}

async function recoverAgentJsonFromEvents(runId, nodeId, expectedKeys) {
  const dbPath = smithersDbPath();
  if (!runId || !nodeId || !existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT payload_json FROM _smithers_events
           WHERE run_id = ? AND type IN ('NodeOutput', 'AgentEvent')
           ORDER BY seq DESC LIMIT 250`
        )
        .all(runId);
      for (const row of rows) {
        const payload = objectFromMaybeJson(row?.payload_json);
        if (payload?.nodeId !== nodeId) continue;
        // AgentEvent payloads carry the agent's final JSON in `event.answer`
        // for `completed` events; `event.message` only exists on `action`
        // events (intermediate thoughts/tool chatter). Checking `answer` first
        // is what lets us recover the structured output the strategist
        // actually produced when the persisted task output came through empty
        // (loose-schema defaults + best-effort sibling-DB recovery under
        // supervision). Without it, dispatch throws
        // "prioritize produced no structured items" even when the agent did
        // emit a valid prioritizedFeatures array.
        const recovered = objectFromMaybeJson(
          payload?.text ?? payload?.event?.answer ?? payload?.event?.message
        );
        if (hasStructuredArray(recovered, expectedKeys)) return recovered;
      }
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  return null;
}

async function hydratedStage(stage, runId, nodeId, expectedKeys) {
  if (hasStructuredArray(stage, expectedKeys)) return stage;
  return (await recoverAgentJsonFromEvents(runId, nodeId, expectedKeys)) || stage || {};
}

function requireNonEmptyStage(stage, items, hint) {
  if (arrayFromMaybeJson(items).length) return;
  throw new TypeError(
    `product-workflow ${stage} produced no structured items; refusing to report a successful zero-feature plan. ${hint}`
  );
}

function assertStageReady(stage, hydrated, keys, hint) {
  const found = keys.some((key) => arrayFromMaybeJson(hydrated?.[key]).length > 0);
  if (found) return hydrated;
  requireNonEmptyStage(stage, [], hint);
  return hydrated;
}

export default smithers((ctx) => {
  const repoDir = resolveImproveRepo(ctx.input, { env: process.env, cwd: process.cwd(), gitBin: GIT, gitEnv: TOOL_ENV });
  const researcher = createResearcher(repoDir);
  const strategist = createStrategist(repoDir);
  const baseline = ctx.outputMaybe("baseline", { nodeId: "baseline" });
  const research = ctx.outputMaybe("research", { nodeId: "research" });
  const researchReady = ctx.outputMaybe("researchReady", { nodeId: "researchReady" });
  const featureMap = ctx.outputMaybe("featureMap", { nodeId: "featureMap" });
  const featureMapReady = ctx.outputMaybe("featureMapReady", { nodeId: "featureMapReady" });
  const prioritize = ctx.outputMaybe("prioritize", { nodeId: "prioritize" });
  const prioritizeReady = ctx.outputMaybe("prioritizeReady", { nodeId: "prioritizeReady" });

  const namedCompetitors = parseNamedList(ctx.input.competitors);

  return (
    <Workflow name="product-workflow">
      <Sequence>
        {/* 0. Record the starting HEAD and the resolved Runyard repo. */}
        <Task id="baseline" output={outputs.baseline} retries={0}>
          {async () => {
            const { execFileSync } = await import("node:child_process");
            const startHead = execFileSync(GIT, ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8", env: TOOL_ENV }).trim();
            return { startHead, repoDir };
          }}
        </Task>

        {/* 1. Research competitors and map their features. */}
        {baseline && (
          <Task id="research" output={outputs.research} agent={researcher} timeoutMs={25 * 60 * 1000}>
            {`Research the competitive landscape for the Runyard app, whose repository is at ${repoDir}.\n\n` +
              `First inspect Runyard's own current features (read src/seeds.js, workflow-templates, README/SPEC, docs) so your comparison is grounded in what already exists.\n\n` +
              (namedCompetitors.length
                ? `Start with these named competitors/products, then add any other clearly relevant ones: ${namedCompetitors.join(", ")}.\n\n`
                : `Identify the most relevant competing or adjacent products yourself.\n\n`) +
              (ctx.input.context ? `=== PRODUCT CONTEXT ===\n${ctx.input.context}\n=== END ===\n\n` : "") +
              `Map at most ${ctx.input.maxCompetitors} competitors. For each, capture name, url, one-line positioning, and a list of notable features. ` +
              `Cite sources (URLs) and list any open questions where evidence was thin.\n\n` +
              `Return JSON {"summary","competitors":[{"name","url","positioning","features":[...],"notes"}],"sources":[...],"openQuestions":[...]}.`}
          </Task>
        )}

        {research && (
          <Task id="researchReady" output={outputs.researchReady} retries={0}>
            {async () =>
              assertStageReady(
                "research",
                await hydratedStage(research, ctx.runId, "research", ["competitors"]),
                ["competitors"],
                "The research agent likely returned unparseable/non-JSON output instead of a competitors array."
              )
            }
          </Task>
        )}

        {/* 2. Synthesize a feature map against Runyard's current capabilities. */}
        {researchReady && (
          <Task id="featureMap" output={outputs.featureMap} agent={strategist} timeoutMs={20 * 60 * 1000}>
            {`Synthesize a feature map for Runyard (repo at ${repoDir}) from the competitor research below.\n\n` +
              `=== COMPETITOR RESEARCH ===\n${JSON.stringify(researchReady, null, 2).slice(0, 60000)}\n=== END ===\n\n` +
              `Inspect the current codebase to decide, for each candidate feature, whether Runyard already has it. ` +
              `Surface the real gaps and opportunities — not generic polish.\n\n` +
              `Return JSON {"summary","features":[{"name","description","competitorsWithIt":[...],"runyardHasIt":true|false,"gap","valueRationale"}],"tableMarkdown"} ` +
              `where tableMarkdown is a compact Markdown table of feature × (competitors / Runyard has it / gap).`}
          </Task>
        )}

        {featureMap && (
          <Task id="featureMapReady" output={outputs.featureMapReady} retries={0}>
            {async () =>
              assertStageReady(
                "featureMap",
                await hydratedStage(featureMap, ctx.runId, "featureMap", ["features"]),
                ["features"],
                "The feature-map agent likely returned unparseable/non-JSON output instead of a features array."
              )
            }
          </Task>
        )}

        {/* 3. Prioritize the gaps into an ordered, buildable list. */}
        {featureMapReady && (
          <Task id="prioritize" output={outputs.prioritize} agent={strategist} timeoutMs={20 * 60 * 1000}>
            {`Prioritize the feature map into at most ${ctx.input.maxFeatures} features to implement for Runyard, ranked by user impact then effort.\n\n` +
              `=== FEATURE MAP ===\n${JSON.stringify(featureMapReady, null, 2).slice(0, 60000)}\n=== END ===\n\n` +
              `Each prioritized feature must be buildable as ONE focused, gated change against the repo at ${repoDir} that can pass pnpm test and push to ${
                ctx.input.targetBranch || "main"
              }. ` +
              `For each, write a self-contained \`workPrompt\` (the exact change request a coding agent will receive — name concrete files/areas), a verifiable acceptanceCheck, a one-line rationale, a priority (must-have | should-have | nice-to-have), and a short conventional commitMessage. ` +
              `List anything you intentionally defer.\n\n` +
              `Return JSON {"summary","prioritizedFeatures":[{"rank","title","priority","rationale","acceptanceCheck","workPrompt","commitMessage"}],"deferred":[...]}.`}
          </Task>
        )}

        {prioritize && (
          <Task id="prioritizeReady" output={outputs.prioritizeReady} retries={0}>
            {async () =>
              assertStageReady(
                "prioritize",
                await hydratedStage(prioritize, ctx.runId, "prioritize", ["prioritizedFeatures", "prioritized_features"]),
                ["prioritizedFeatures", "prioritized_features"],
                "The prioritization agent likely returned unparseable/non-JSON output instead of a prioritizedFeatures array."
              )
            }
          </Task>
        )}

        {/* 4. Dispatch one gated implementation per feature — strictly sequential. */}
        {prioritizeReady && (
          <Task id="dispatch" output={outputs.dispatch} retries={0} timeoutMs={POLL_DEADLINE_MS + 60_000}>
            {async () => {
              const recoveredResearch = researchReady;
              const recoveredFeatureMap = featureMapReady;
              const recoveredPrioritize = prioritizeReady;
              const prioritizedItems = arrayFromMaybeJson(
                recoveredPrioritize?.prioritizedFeatures ?? recoveredPrioritize?.prioritized_features
              );
              // Only the final stage gates dispatch. Upstream agents (research,
              // featureMap) may legitimately persist as empty arrays via their
              // loose-schema defaults — and event-log recovery is best-effort
              // (the DB may live in a sibling workspace under supervision) —
              // even when the strategist still produces a usable prioritized
              // list. Throwing on those would refuse a perfectly valid plan, so
              // we keep their diagnostic hints in source for tooling without
              // gating on them:
              //   "The research agent likely returned unparseable/non-JSON output instead of a competitors array."
              //   "The feature-map agent likely returned unparseable/non-JSON output instead of a features array."
              requireNonEmptyStage(
                "prioritize",
                prioritizedItems,
                "The prioritization agent likely returned unparseable/non-JSON output instead of a prioritizedFeatures array."
              );

              const features = prioritizedItems
                .slice()
                .sort((a, b) => (a.rank || 0) - (b.rank || 0))
                .slice(0, ctx.input.maxFeatures)
                .map((f, i) => ({ ...f, rank: f.rank || i + 1 }));

              const targetRepo = ctx.input.repoDir || ctx.input.project || ctx.input.repo || "smithers-hub";
              const targetBranch = ctx.input.targetBranch || "main";

              // Plan-only: report the runs that WOULD be created, no Hub calls.
              if (!ctx.input.execute) {
                const dispatched = features.map((f) => ({
                  rank: f.rank,
                  title: f.title,
                  runId: "",
                  status: "planned",
                  commit: "",
                  pushed: false,
                  error: "",
                  payload: buildChildPayload(f, ctx.input)
                }));
                return {
                  executed: false,
                  targetRepo,
                  targetBranch,
                  pushedToMain: false,
                  dispatched,
                  artifactName: "product-workflow-report.md",
                  report: renderReport(ctx, recoveredResearch, recoveredFeatureMap, features, dispatched, false),
                  notes: `Plan only. Set execute=true to queue ${features.length} gated implement-change-gated run(s) sequentially.`
                };
              }

              // Execute: queue one implement-change-gated run per feature, strictly
              // sequential — wait for each to reach a terminal state before the next
              // so two builders never edit the repo at the same time.
              const dispatched = [];
              let anyPushed = false;
              for (const f of features) {
                const payload = buildChildPayload(f, ctx.input);
                let runId = "";
                let status = "error";
                let commit = "";
                let pushed = false;
                let error = "";
                try {
                  const created = await hubJson(`/api/capabilities/implement-change-gated/run`, {
                    method: "POST",
                    body: {
                      input: payload,
                      origin: {
                        type: "product-workflow",
                        label: `product-workflow feature #${f.rank}: ${String(f.title || "").slice(0, 60)}`,
                        parentRunId: ctx.runId || ""
                      }
                    }
                  });
                  runId = created?.run?.id || "";
                  const finished = runId ? await pollRunToTerminal(runId) : null;
                  status = finished?.status || (runId ? "timeout" : "not_created");
                  const out = finished?.output || {};
                  commit = String(out?.commit?.commit || out?.commit || "");
                  pushed = Boolean(out?.push?.pushed);
                  if (pushed) anyPushed = true;
                  if (status !== "succeeded") {
                    error = String(finished?.error || `child run ended as ${status}`).slice(0, 300);
                    // Stop the line on failure: do not start the next feature on a
                    // repo that may be mid-change.
                    dispatched.push({ rank: f.rank, title: f.title, runId, status, commit, pushed, error, payload });
                    break;
                  }
                } catch (e) {
                  error = String(e?.message || e).slice(0, 300);
                  dispatched.push({ rank: f.rank, title: f.title, runId, status: "error", commit, pushed, error, payload });
                  break;
                }
                dispatched.push({ rank: f.rank, title: f.title, runId, status, commit, pushed, error, payload });
              }

              return {
                executed: true,
                targetRepo,
                targetBranch,
                pushedToMain: anyPushed && targetBranch === "main",
                dispatched,
                artifactName: "product-workflow-report.md",
                report: renderReport(ctx, recoveredResearch, recoveredFeatureMap, features, dispatched, true),
                notes: `Queued ${dispatched.length} implementation run(s) sequentially; ${
                  dispatched.filter((d) => d.status === "succeeded").length
                } succeeded.`
              };
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
