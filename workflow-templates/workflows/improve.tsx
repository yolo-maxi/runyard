// smithers-source: authored
// smithers-display-name: Improve
// smithers-description: Inspects an existing feature, UI, or workflow with a taste-led Product Manager, prioritizes improvements with acceptance checks, then dispatches a builder to apply them through the gated test/commit/push/deploy pipeline. PM analysis runs first; builder consumes that brief and the same gates as implement-change-gated run after.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import { existsSync } from "node:fs";
import { z } from "zod/v4";
import { resolveImproveRepo } from "./improve-repo.js";
import { createAgentFallbackPair } from "./agent-fallback.js";
import { runyardAgentSystemPrompt } from "./runyard-runtime.js";
import { prepareMutatingRepo, releaseRepoLease, validateBeforeCommit, validateBeforePush } from "./repo-mutation-lease.js";

// Repo + deploy target are deployment-specific; set env vars on your runner.
const PROD_REMOTE = process.env.GATED_PROD_REMOTE || "prod";
const PROD_HOST = process.env.GATED_PROD_HOST || "";
const PROD_DIR = process.env.GATED_PROD_DIR || "";
const DEPLOY_KEY = process.env.GATED_DEPLOY_KEY || "";
const HEALTH_BASE = process.env.GATED_HEALTH_URL || process.env.BASE_URL || "http://127.0.0.1:43117";

function resolveTool(envName, fallback, candidates) {
  const configured = process.env[envName];
  if (configured) return configured;
  return candidates.find((candidate) => existsSync(candidate)) || fallback;
}
const GIT = resolveTool("GATED_GIT_BIN", "git", ["/usr/bin/git", "/usr/local/bin/git"]);
const PNPM = resolveTool("GATED_PNPM_BIN", "pnpm", [
  "/usr/local/bin/pnpm",
  "/usr/bin/pnpm"
]);
const SSH = resolveTool("GATED_SSH_BIN", "ssh", ["/usr/bin/ssh", "/usr/local/bin/ssh"]);
const CURL = resolveTool("GATED_CURL_BIN", "curl", ["/usr/bin/curl", "/usr/local/bin/curl"]);
const TOOL_PATH = [
  process.env.PATH || "",
  "/usr/local/bin",
  "/usr/bin",
  "/bin"
].filter(Boolean).join(":");
const TOOL_ENV = { ...process.env, PATH: TOOL_PATH };

const repoLeaseOut = z.object({
  schemaVersion: z.number().default(1),
  mode: z.enum(["sequential", "parallel"]).default("sequential"),
  leaseId: z.string().default(""),
  runId: z.string().default(""),
  pid: z.number().default(0),
  workflow: z.string().default(""),
  repoDir: z.string().default(""),
  sourceRepoDir: z.string().default(""),
  targetBranch: z.string().default("main"),
  startBranch: z.string().default(""),
  sourceBranch: z.string().default(""),
  startHead: z.string().default(""),
  key: z.string().default(""),
  lockDir: z.string().default(""),
  workRepoDir: z.string().default(""),
  workBranch: z.string().default(""),
  pushBranch: z.string().default(""),
  acquiredAt: z.string().default("")
});
const baselineOut = z.object({
  startHead: z.string(),
  repoDir: z.string().default(""),
  targetBranch: z.string().default("main"),
  lease: repoLeaseOut
});
const reviewOut = z.object({
  summary: z.string().default(""),
  userPain: z.array(z.string()).default([]),
  improvements: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string().default(""),
        change: z.string().default(""),
        priority: z.string().default(""),
        acceptanceCheck: z.string().default("")
      })
    )
    .default([]),
  builderPrompt: z.string().default(""),
  risks: z.array(z.string()).default([])
});
const implementOut = z.object({ summary: z.string().default(""), notes: z.string().default("") });
const testOut = z.object({ passed: z.boolean(), tail: z.string().default("") });
const commitOut = z.object({ commit: z.string(), message: z.string(), stat: z.string().default(""), files: z.array(z.string()).default([]) });
const pushOut = z.object({ pushed: z.boolean(), branch: z.string(), detail: z.string().default("") });
const deployOut = z.object({ deployed: z.boolean(), wouldDeploy: z.boolean().default(false), target: z.string().default(""), verify: z.string().default("") });

const inputSchema = z.object({
  target: z
    .string()
    .default("")
    .describe("What to improve — a feature, UI, workflow slug, file path, or short description the PM should inspect."),
  request: z
    .string()
    .default("")
    .describe("Back-compat alias for target used by older Hub/UI rerun payloads."),
  context: z.string().default("").describe("Optional product context, user complaints, links, or constraints."),
  repoDir: z
    .string()
    .default("")
    .describe("Absolute runner-local git repo path to inspect/edit. Must be inside the default repo root or IMPROVE_ALLOWED_REPO_ROOTS."),
  repo: z
    .string()
    .default("")
    .describe("Optional friendly repo key resolved from the runner's IMPROVE_REPO_MAP JSON object."),
  project: z
    .string()
    .default("")
    .describe("Optional friendly project key resolved from IMPROVE_PROJECT_MAP or IMPROVE_REPO_MAP."),
  maxImprovements: z.number().int().min(1).max(6).default(3),
  deploy: z.boolean().default(false).describe("If true, deploy to prod after gates pass."),
  targetBranch: z.string().default("main"),
  mutationMode: z
    .enum(["sequential", "parallel"])
    .default("parallel")
    .describe("Mutating checkout mode. parallel creates a unique branch/worktree and requires a later Hub promotion; sequential takes a repo/branch lease and pushes directly.")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  baseline: baselineOut,
  review: reviewOut,
  implement: implementOut,
  test: testOut,
  commit: commitOut,
  push: pushOut,
  deploy: deployOut
});

function createProductManager(repoDir) {
  const systemPrompt = runyardAgentSystemPrompt(
    "product-manager",
    [
      "You are reviewing an existing feature inside this repository.",
      "Inspect the actual current behavior (read code, configs, prompts, UI, copy) before passing judgment.",
      "Stay inside the requested target and product context. Do not broaden a narrow request into unrelated product, naming, landing-page, deploy, or architecture work.",
      "If you cannot find target-specific improvements, return an empty improvements array and explain the blocker in risks.",
      "Do NOT modify files; you are reviewing only. Return only the requested JSON."
    ].join(" "),
    { skillSlugs: ["product-review", "spec-writing"] }
  );
  return createAgentFallbackPair({
    ClaudeCodeAgent,
    CodexAgent,
    primaryCli: process.env.RUNYARD_IMPROVE_AGENT_CLI || "claude",
    label: "improve-product-manager",
    cwd: repoDir,
    claude: {
      model: process.env.RUNYARD_IMPROVE_CLAUDE_MODEL || "claude-opus-4-7",
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      timeoutMs: 20 * 60 * 1000,
      systemPrompt
    },
    codex: {
      ...(process.env.RUNYARD_IMPROVE_CODEX_MODEL ? { model: process.env.RUNYARD_IMPROVE_CODEX_MODEL } : {}),
      sandbox: "read-only"
    }
  });
}

function createBuilder(repoDir) {
  const systemPrompt = runyardAgentSystemPrompt(
    "implementation-agent",
    [
      "You are an implementation agent working inside a git repository.",
      "Apply the Product Manager's prioritized improvements with tight, idiomatic edits that match the surrounding code.",
      "Do NOT git commit, git push, or deploy, and do NOT run the test suite — a separate gated pipeline runs tests, commits, pushes, and deploys.",
      "Treat each acceptance check as a definition of done.",
      "For UI, app, dashboard, or web-surface changes, preserve mobile usability and verify text/layout at narrow widths where possible."
    ].join(" "),
    { skillSlugs: ["implementation"] }
  );
  return createAgentFallbackPair({
    ClaudeCodeAgent,
    CodexAgent,
    primaryCli: process.env.RUNYARD_IMPROVE_AGENT_CLI || "claude",
    label: "improve-builder",
    cwd: repoDir,
    claude: {
      model: process.env.RUNYARD_IMPROVE_CLAUDE_MODEL || "claude-opus-4-7",
      dangerouslySkipPermissions: true,
      timeoutMs: 45 * 60 * 1000,
      systemPrompt
    },
    codex: {
      ...(process.env.RUNYARD_IMPROVE_CODEX_MODEL ? { model: process.env.RUNYARD_IMPROVE_CODEX_MODEL } : {}),
      sandbox: "danger-full-access"
    }
  });
}

function improveScopeContract(input) {
  const target = String(input?.target || input?.request || "").trim();
  const context = String(input?.context || "").trim();
  return [
    "HARD SCOPE CONTRACT:",
    `- Target: ${target || "(missing)"}`,
    context ? `- Context: ${context}` : "- Context: (none)",
    "- Propose and implement only improvements directly supported by that target/context.",
    "- Do not switch surfaces. Examples: a docs/runbook target must not become landing-page work; a mobile target must not become a naming/deploy-topology rewrite.",
    "- Do not rename the product, change deploy topology, add new public surfaces, or alter unrelated workflows unless explicitly requested in target/context.",
    "- If there are no target-specific changes worth making, return an empty change set instead of inventing adjacent work.",
    "- If the change touches UI/web/app/dashboard surfaces, include mobile/narrow-viewport acceptance checks."
  ].join("\n");
}

export default smithers((ctx) => {
  const effectiveInput = {
    ...ctx.input,
    target: String(ctx.input?.target || ctx.input?.request || "").trim()
  };
  // Resolve the target repo. This must be explicit/configured, not guessed from
  // nearby directories: a green Improve run is only trustworthy when it edited
  // the repo the operator intended.
  let repoDir;
  let repoResolveError = null;
  const repoOptions = { env: process.env, cwd: process.cwd(), gitBin: GIT, gitEnv: TOOL_ENV };
  try {
    repoDir = resolveImproveRepo(effectiveInput, repoOptions);
  } catch (err) {
    repoResolveError = err;
    repoDir = String(ctx.input?.repoDir || "").trim() || process.cwd();
  }
  const baseline = ctx.outputMaybe("baseline", { nodeId: "baseline" });
  const productManager = createProductManager(repoDir);
  const workRepoDir = baseline?.repoDir || repoDir;
  const builder = baseline ? createBuilder(workRepoDir) : null;
  const review = ctx.outputMaybe("review", { nodeId: "review" });
  const impl = ctx.outputMaybe("implement", { nodeId: "implement" });
  const test = ctx.outputMaybe("test", { nodeId: "test" });
  const commit = ctx.outputMaybe("commit", { nodeId: "commit" });
  const push = ctx.outputMaybe("push", { nodeId: "push" });

  return (
    <Workflow name="improve">
      <Sequence>
        {/* 0. Acquire a mutating repo lease or create an explicit parallel worktree. */}
        <Task id="baseline" output={outputs.baseline} retries={0}>
          {async () => {
            if (repoResolveError) throw repoResolveError;
            if (!effectiveInput.target) {
              throw new Error("Improve requires target (or legacy request) to describe what should change.");
            }
            if ((effectiveInput.mutationMode || "sequential") === "parallel" && effectiveInput.deploy) {
              throw new Error("PARALLEL MODE BLOCKED: deploy=true is not allowed from an isolated worktree.");
            }
            const lease = prepareMutatingRepo({
              repoDir,
              targetBranch: effectiveInput.targetBranch || "main",
              workflow: "improve",
              mode: effectiveInput.mutationMode || "sequential",
              gitBin: GIT,
              gitEnv: TOOL_ENV,
              env: process.env
            });
            return { startHead: lease.startHead, repoDir: lease.workRepoDir || lease.repoDir, targetBranch: lease.pushBranch, lease };
          }}
        </Task>

        {/* 1. Product Manager (with taste) inspects the target and proposes prioritized improvements. */}
        {baseline && (
          <Task id="review" output={outputs.review} agent={productManager} timeoutMs={20 * 60 * 1000}>
            {`You are inspecting an existing feature inside the repository at ${repoDir}.\n\n` +
              `${improveScopeContract(effectiveInput)}\n\n` +
              `=== WHAT TO REVIEW ===\n${effectiveInput.target}\n=== END ===\n\n` +
              (effectiveInput.context ? `=== PRODUCT CONTEXT / USER NOTES ===\n${effectiveInput.context}\n=== END ===\n\n` : "") +
              `Propose at most ${effectiveInput.maxImprovements} prioritized improvements. Rank by user impact, then effort. ` +
              `Every improvement must explicitly name how it stays inside the hard scope contract. ` +
              `Reject tempting adjacent work unless the target/context asks for it. ` +
              `For each improvement include: title, rationale, change (concrete builder instruction), priority (must-fix | should-fix | polish), acceptanceCheck.\n\n` +
              `Also write a single \`builderPrompt\` string that a coding agent can act on directly to implement ALL improvements together, ` +
              `referencing concrete files, components, acceptance checks, and the hard scope contract. The builderPrompt should be self-contained.\n\n` +
              `Return JSON {"summary","userPain":[...],"improvements":[{"title","rationale","change","priority","acceptanceCheck"}],"builderPrompt","risks":[...]}.`}
          </Task>
        )}

        {/* 2. Builder applies the PM's prioritized improvements (edits only). */}
        {review && (
          <Task id="implement" output={outputs.implement} agent={builder} timeoutMs={45 * 60 * 1000}>
            {`Apply these prioritized improvements to the repository at ${workRepoDir}. Edit files only — do not commit, push, deploy, or run tests.\n\n` +
              `RUN LEASE: mode=${baseline.lease?.mode || "sequential"} runId=${baseline.lease?.runId || "unknown"} targetBranch=${baseline.targetBranch || effectiveInput.targetBranch || "main"}. ` +
              `If the checkout is dirty before you edit, HEAD changes unexpectedly, or another lease appears to own this repo, stop and report the operator action instead of working around it.\n\n` +
              `${improveScopeContract(effectiveInput)}\n\n` +
              `=== PM SUMMARY ===\n${review.summary || "(no summary)"}\n\n` +
              `=== USER PAIN ===\n${(review.userPain || []).map((line, i) => `${i + 1}. ${line}`).join("\n") || "(none)"}\n\n` +
              `=== IMPROVEMENTS TO IMPLEMENT ===\n${
                (review.improvements || [])
                  .map(
                    (imp, i) =>
                      `${i + 1}. [${imp.priority || "?"}] ${imp.title}\n   change: ${imp.change}\n   acceptance: ${imp.acceptanceCheck}`
                  )
                  .join("\n") || "(none — return an empty change set)"
              }\n\n` +
              `=== BUILDER PROMPT FROM PM ===\n${review.builderPrompt || "(use the improvements list above as your work plan)"}\n=== END ===\n\n` +
              `When finished, return JSON {"summary": <what you changed>, "notes": <risks/tradeoffs>}.`}
          </Task>
        )}

        {/* 3. GATE: pnpm test must pass, or the run fails here (nothing committed/pushed/deployed). */}
        {impl && (
          <Task id="test" output={outputs.test} retries={0}>
            {async () => {
              const { execFileSync } = await import("node:child_process");
              let out = "";
              let passed = false;
              try {
                out = execFileSync(PNPM, ["test"], { cwd: workRepoDir, encoding: "utf8", env: TOOL_ENV, maxBuffer: 1024 * 1024 * 64 });
                passed = true;
              } catch (e) {
                out = `${e.stdout || ""}${e.stderr || ""}${e.message || ""}`;
                passed = false;
              }
              const tail = out.split("\n").slice(-30).join("\n");
              if (!passed) throw new Error(`GATE FAILED: pnpm test did not pass.\n${tail}`);
              return { passed, tail };
            }}
          </Task>
        )}

        {/* 4. GATE: stage, confirm a real change, and produce a sane commit. */}
        {test && (
          <Task id="commit" output={outputs.commit} retries={0}>
            {async () => {
              const { execFileSync } = await import("node:child_process");
              validateBeforeCommit(baseline.lease, { gitBin: GIT, gitEnv: TOOL_ENV });
              const run = (args) => execFileSync(GIT, args, { cwd: workRepoDir, encoding: "utf8", env: TOOL_ENV });
              run(["add", "-A"]);
              const staged = run(["diff", "--cached", "--name-only"]).split("\n").map((s) => s.trim()).filter(Boolean);
              const stat = run(["diff", "--cached", "--stat"]).trim();
              const headline = (review?.improvements?.[0]?.title || effectiveInput.target || "improve").slice(0, 60);
              const msg = `improve: ${headline}`;
              let commitHash;
              if (staged.length > 0) {
                run(["commit", "-m", msg]);
                commitHash = run(["rev-parse", "HEAD"]).trim();
              } else {
                const improvements = Array.isArray(review?.improvements) ? review.improvements : [];
                const noChangeEvidence = improvements.length === 0 && (
                  String(review?.summary || "").trim()
                  || (Array.isArray(review?.risks) && review.risks.some((risk) => String(risk || "").trim()))
                  || (Array.isArray(review?.userPain) && review.userPain.some((line) => String(line || "").trim()))
                );
                if (!noChangeEvidence) {
                  throw new Error(
                    "GATE FAILED: improve produced no changed files. " +
                    "A successful Improve run must produce a diff, or the PM review must explicitly conclude there is nothing to change."
                  );
                }
                commitHash = run(["rev-parse", "HEAD"]).trim();
              }
              if (!/^[0-9a-f]{7,40}$/.test(commitHash)) throw new Error("GATE FAILED: no sane commit hash.");
              return { commit: commitHash, message: msg, stat, files: staged };
            }}
          </Task>
        )}

        {/* 5. GATE: push to origin. */}
        {commit && (
          <Task id="push" output={outputs.push} retries={1}>
            {async () => {
              const { execFileSync } = await import("node:child_process");
              const branch = baseline.targetBranch || effectiveInput.targetBranch || "main";
              if (baseline.lease?.mode === "parallel" && branch === (effectiveInput.targetBranch || "main")) {
                throw new Error("PARALLEL MODE BLOCKED: isolated workers may only push their unique work branch.");
              }
              validateBeforePush(baseline.lease, commit.commit, { gitBin: GIT, gitEnv: TOOL_ENV });
              let detail = "";
              try {
                detail = execFileSync(GIT, ["push", "origin", `HEAD:${branch}`], { cwd: workRepoDir, encoding: "utf8", env: TOOL_ENV, stdio: ["ignore", "pipe", "pipe"] });
              } catch (e) {
                detail = `${e.stdout || ""}${e.stderr || ""}`;
                throw new Error(`GATE FAILED: git push origin failed.\n${detail.slice(0, 800)}`);
              }
              return { pushed: true, branch, detail: String(detail).slice(0, 500) };
            }}
          </Task>
        )}

        {/* 6. Deploy (or report what would deploy). */}
        {push && (
          <Task id="deploy" output={outputs.deploy} retries={0}>
            {async () => {
              const { execFileSync } = await import("node:child_process");
              if (baseline.lease?.mode === "parallel" && effectiveInput.deploy) {
                throw new Error("PARALLEL MODE BLOCKED: deploy=true is not allowed from an isolated worktree.");
              }
              const target = PROD_HOST && PROD_DIR ? `${PROD_REMOTE} (${PROD_HOST}:${PROD_DIR})` : `${PROD_REMOTE} (not configured)`;
              if (!effectiveInput.deploy) {
                releaseRepoLease(baseline.lease, { env: process.env });
                return { deployed: false, wouldDeploy: true, target, verify: `deploy=false — would push ${commit.commit} to ${target}, reset main, and restart the hub.` };
              }
              if (!PROD_HOST || !PROD_DIR || !DEPLOY_KEY) {
                throw new Error("GATE FAILED: deploy=true requires GATED_PROD_HOST, GATED_PROD_DIR, and GATED_DEPLOY_KEY on the runner.");
              }
              const env = { ...TOOL_ENV, GIT_SSH_COMMAND: `${SSH} -i ${DEPLOY_KEY} -o BatchMode=yes -o StrictHostKeyChecking=accept-new` };
              execFileSync(GIT, ["push", PROD_REMOTE, `${commit.commit}:refs/heads/sync-tmp`], { cwd: workRepoDir, encoding: "utf8", env });
              const remoteCmd = `cd ${PROD_DIR} && git checkout -q main && git reset --hard sync-tmp && git branch -D sync-tmp; rm -f data/cli.tgz && systemctl --user restart smithers-hub.service && sleep 2 && git log --oneline -1`;
              const remoteOut = execFileSync(
                SSH,
                ["-i", DEPLOY_KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", PROD_HOST, remoteCmd],
                { encoding: "utf8", env: TOOL_ENV }
              );
              let verify = "";
              for (const p of ["/healthz", "/", "/docs", "/app"]) {
                const code = execFileSync(CURL, ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", `${HEALTH_BASE}${p}`], { encoding: "utf8", env: TOOL_ENV });
                verify += `${p}:${code} `;
              }
              releaseRepoLease(baseline.lease, { env: process.env });
              return { deployed: true, wouldDeploy: false, target, verify: `remote HEAD: ${remoteOut.trim().split("\n").pop()} | routes: ${verify.trim()}` };
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
