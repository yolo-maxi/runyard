// smithers-source: authored
// smithers-display-name: Improve
// smithers-description: Inspects an existing feature, UI, or workflow with a taste-led Product Manager, prioritizes improvements with acceptance checks, then dispatches a builder to apply them through the gated test/commit/push/deploy pipeline. PM analysis runs first; builder consumes that brief and the same gates as implement-change-gated run after.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent } from "smithers-orchestrator";
import { existsSync } from "node:fs";
import { z } from "zod/v4";
import { resolveImproveRepo } from "./improve-repo.js";

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

const baselineOut = z.looseObject({ startHead: z.string(), repoDir: z.string().default("") });
const reviewOut = z.looseObject({
  summary: z.string().default(""),
  userPain: z.array(z.string()).default([]),
  improvements: z
    .array(
      z.looseObject({
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
const implementOut = z.looseObject({ summary: z.string().default(""), notes: z.string().default("") });
const testOut = z.looseObject({ passed: z.boolean(), tail: z.string().default("") });
const commitOut = z.looseObject({ commit: z.string(), message: z.string(), stat: z.string().default(""), files: z.array(z.string()).default([]) });
const pushOut = z.looseObject({ pushed: z.boolean(), branch: z.string(), detail: z.string().default("") });
const deployOut = z.looseObject({ deployed: z.boolean(), wouldDeploy: z.boolean().default(false), target: z.string().default(""), verify: z.string().default("") });

const inputSchema = z.object({
  target: z.string().describe("What to improve — a feature, UI, workflow slug, file path, or short description the PM should inspect."),
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
  targetBranch: z.string().default("main")
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
  return new ClaudeCodeAgent({
    model: "claude-opus-4-7",
    cwd: repoDir,
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    timeoutMs: 20 * 60 * 1000,
    systemPrompt:
      "You are a Product Manager with taste, reviewing an existing feature inside this repository. " +
      "Inspect the actual current behavior (read code, configs, prompts, UI, copy) before passing judgment. " +
      "Stay inside the requested target and product context. Do not broaden a narrow request into unrelated product, naming, landing-page, deploy, or architecture work. " +
      "If you cannot find target-specific improvements, return an empty improvements array and explain the blocker in risks. " +
      "Lead with the user's real experience: what is confusing, slow, ugly, surprising, or broken? " +
      "Name concrete frictions in plain language and rank improvements by user impact, then effort. " +
      "For each improvement write a one-sentence rationale, a concrete change a builder can act on, and a verifiable acceptance check. " +
      "For UI, app, dashboard, or web-surface changes, include mobile readability, tap target, and narrow-viewport acceptance checks by default. " +
      "Cut anything you cannot defend as user-visible value. Do NOT modify files; you are reviewing only. Return only the requested JSON."
  });
}

function createBuilder(repoDir) {
  return new ClaudeCodeAgent({
    model: "claude-opus-4-7",
    cwd: repoDir,
    dangerouslySkipPermissions: true,
    timeoutMs: 45 * 60 * 1000,
    systemPrompt:
      "You are an implementation agent working inside a git repository. Apply the Product Manager's prioritized improvements with tight, idiomatic edits that match the surrounding code. " +
      "Do NOT git commit, git push, or deploy, and do NOT run the test suite — a separate gated pipeline runs tests, commits, pushes, and deploys. " +
      "Treat each acceptance check as a definition of done. Keep changes scoped to the listed improvements and hard scope contract; do not touch unrelated files. " +
      "For UI, app, dashboard, or web-surface changes, preserve mobile usability and verify text/layout at narrow widths where possible."
  });
}

function improveScopeContract(input) {
  const target = String(input?.target || "").trim();
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
  const repoDir = resolveImproveRepo(ctx.input, { env: process.env, cwd: process.cwd(), gitBin: GIT, gitEnv: TOOL_ENV });
  const productManager = createProductManager(repoDir);
  const builder = createBuilder(repoDir);
  const baseline = ctx.outputMaybe("baseline", { nodeId: "baseline" });
  const review = ctx.outputMaybe("review", { nodeId: "review" });
  const impl = ctx.outputMaybe("implement", { nodeId: "implement" });
  const test = ctx.outputMaybe("test", { nodeId: "test" });
  const commit = ctx.outputMaybe("commit", { nodeId: "commit" });
  const push = ctx.outputMaybe("push", { nodeId: "push" });

  return (
    <Workflow name="improve">
      <Sequence>
        {/* 0. Record the starting HEAD so we can tell what the builder produced. */}
        <Task id="baseline" output={outputs.baseline} retries={0}>
          {async () => {
            const { execFileSync } = await import("node:child_process");
            const startHead = execFileSync(GIT, ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8", env: TOOL_ENV }).trim();
            return { startHead, repoDir };
          }}
        </Task>

        {/* 1. Product Manager (with taste) inspects the target and proposes prioritized improvements. */}
        {baseline && (
          <Task id="review" output={outputs.review} agent={productManager} timeoutMs={20 * 60 * 1000}>
            {`You are inspecting an existing feature inside the repository at ${repoDir}.\n\n` +
              `${improveScopeContract(ctx.input)}\n\n` +
              `=== WHAT TO REVIEW ===\n${ctx.input.target}\n=== END ===\n\n` +
              (ctx.input.context ? `=== PRODUCT CONTEXT / USER NOTES ===\n${ctx.input.context}\n=== END ===\n\n` : "") +
              `Propose at most ${ctx.input.maxImprovements} prioritized improvements. Rank by user impact, then effort. ` +
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
            {`Apply these prioritized improvements to the repository at ${repoDir}. Edit files only — do not commit, push, deploy, or run tests.\n\n` +
              `${improveScopeContract(ctx.input)}\n\n` +
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
                out = execFileSync(PNPM, ["test"], { cwd: repoDir, encoding: "utf8", env: TOOL_ENV, maxBuffer: 1024 * 1024 * 64 });
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
              const run = (args) => execFileSync(GIT, args, { cwd: repoDir, encoding: "utf8", env: TOOL_ENV });
              run(["add", "-A"]);
              const staged = run(["diff", "--cached", "--name-only"]).split("\n").map((s) => s.trim()).filter(Boolean);
              const stat = run(["diff", "--cached", "--stat"]).trim();
              const headline = (review?.improvements?.[0]?.title || ctx.input.target || "improve").slice(0, 60);
              const msg = `improve: ${headline}`;
              let commitHash;
              if (staged.length > 0) {
                run(["commit", "-m", msg]);
                commitHash = run(["rev-parse", "HEAD"]).trim();
              } else {
                const head = run(["rev-parse", "HEAD"]).trim();
                if (head === baseline.startHead) throw new Error("GATE FAILED: implementation produced no changes.");
                commitHash = head;
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
              const branch = ctx.input.targetBranch || "main";
              let detail = "";
              try {
                detail = execFileSync(GIT, ["push", "origin", `HEAD:${branch}`], { cwd: repoDir, encoding: "utf8", env: TOOL_ENV, stdio: ["ignore", "pipe", "pipe"] });
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
              const target = PROD_HOST && PROD_DIR ? `${PROD_REMOTE} (${PROD_HOST}:${PROD_DIR})` : `${PROD_REMOTE} (not configured)`;
              if (!ctx.input.deploy) {
                return { deployed: false, wouldDeploy: true, target, verify: `deploy=false — would push ${commit.commit} to ${target}, reset main, and restart the hub.` };
              }
              if (!PROD_HOST || !PROD_DIR || !DEPLOY_KEY) {
                throw new Error("GATE FAILED: deploy=true requires GATED_PROD_HOST, GATED_PROD_DIR, and GATED_DEPLOY_KEY on the runner.");
              }
              const env = { ...TOOL_ENV, GIT_SSH_COMMAND: `${SSH} -i ${DEPLOY_KEY} -o BatchMode=yes -o StrictHostKeyChecking=accept-new` };
              execFileSync(GIT, ["push", PROD_REMOTE, `${commit.commit}:refs/heads/sync-tmp`], { cwd: repoDir, encoding: "utf8", env });
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
              return { deployed: true, wouldDeploy: false, target, verify: `remote HEAD: ${remoteOut.trim().split("\n").pop()} | routes: ${verify.trim()}` };
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
