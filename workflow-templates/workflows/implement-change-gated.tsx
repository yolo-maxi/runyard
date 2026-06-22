// smithers-source: authored
// smithers-display-name: Implement Change (gated)
// smithers-description: Runs an implementation agent for a change request, then gates it (pnpm test, staged diff, a sane commit, push to origin) before optionally deploying to a configured production target. deploy=false stops after push and reports what would deploy.
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

const baselineOut = z.looseObject({ startHead: z.string() });
const implementOut = z.looseObject({ summary: z.string().default(""), notes: z.string().default("") });
const testOut = z.looseObject({ passed: z.boolean(), tail: z.string().default("") });
const commitOut = z.looseObject({ commit: z.string(), message: z.string(), stat: z.string().default(""), files: z.array(z.string()).default([]) });
const pushOut = z.looseObject({ pushed: z.boolean(), branch: z.string(), detail: z.string().default("") });
const deployOut = z.looseObject({ deployed: z.boolean(), wouldDeploy: z.boolean().default(false), target: z.string().default(""), verify: z.string().default("") });

const inputSchema = z.object({
  workPrompt: z.string().describe("The change request / implementation prompt."),
  deploy: z.boolean().default(false).describe("If true, deploy to prod after gates pass."),
  targetBranch: z.string().default("main"),
  commitMessage: z.string().default(""),
  repoDir: z.string().default("").describe("Absolute runner-local git repo path to edit. Must be inside allowed improve repo roots."),
  repo: z.string().default("").describe("Optional friendly repo key resolved on the runner from IMPROVE_REPO_MAP JSON."),
  project: z.string().default("").describe("Optional friendly project key resolved from IMPROVE_PROJECT_MAP or IMPROVE_REPO_MAP.")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  baseline: baselineOut,
  implement: implementOut,
  test: testOut,
  commit: commitOut,
  push: pushOut,
  deploy: deployOut
});

function createBuilder(repoDir) {
  return new ClaudeCodeAgent({
    model: "claude-opus-4-7",
    cwd: repoDir,
    dangerouslySkipPermissions: true,
    timeoutMs: 45 * 60 * 1000,
    systemPrompt:
      "You are an implementation agent working inside a git repository. Make the requested change with tight, idiomatic edits that match the surrounding code. " +
      "Do NOT git commit, git push, or deploy, and do NOT run the test suite — a separate gated pipeline runs tests, commits, pushes, and deploys. Keep changes scoped; do not touch unrelated files."
  });
}

export default smithers((ctx) => {
  // Collapse the friendly selector to a single field so resolveImproveRepo doesn't reject
  // callers that fill in both `repo` and `project` (e.g. an alias pair) with different values.
  const improveInput = {
    ...ctx.input,
    repo: ctx.input.repo || ctx.input.project,
    project: ""
  };
  const repoDir = resolveImproveRepo(improveInput, { env: process.env, cwd: process.cwd(), gitBin: GIT, gitEnv: TOOL_ENV });
  const builder = createBuilder(repoDir);
  const baseline = ctx.outputMaybe("baseline", { nodeId: "baseline" });
  const impl = ctx.outputMaybe("implement", { nodeId: "implement" });
  const test = ctx.outputMaybe("test", { nodeId: "test" });
  const commit = ctx.outputMaybe("commit", { nodeId: "commit" });
  const push = ctx.outputMaybe("push", { nodeId: "push" });

  return (
    <Workflow name="implement-change-gated">
      <Sequence>
        {/* 0. Record the starting HEAD so we can tell what the agent produced. */}
        <Task id="baseline" output={outputs.baseline} retries={0}>
          {async () => {
            const { execFileSync } = await import("node:child_process");
            const startHead = execFileSync(GIT, ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8", env: TOOL_ENV }).trim();
            return { startHead };
          }}
        </Task>

        {/* 1. Implementation agent makes the change (edits only). */}
        {baseline && (
          <Task id="implement" output={outputs.implement} agent={builder} timeoutMs={45 * 60 * 1000}>
            {`Implement this change request in the repository at ${repoDir}. Edit files only — do not commit, push, deploy, or run tests.\n\n` +
              `=== CHANGE REQUEST ===\n${ctx.input.workPrompt}\n=== END ===\n\n` +
              `When finished, return JSON {"summary": <what you changed>, "notes": <risks/tradeoffs>}.`}
          </Task>
        )}

        {/* 2. GATE: pnpm test must pass, or the run fails here (nothing committed/pushed/deployed). */}
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

        {/* 3. GATE: stage, confirm a real change, and produce a sane commit. */}
        {test && (
          <Task id="commit" output={outputs.commit} retries={0}>
            {async () => {
              const { execFileSync } = await import("node:child_process");
              const run = (args) => execFileSync(GIT, args, { cwd: repoDir, encoding: "utf8", env: TOOL_ENV });
              run(["add", "-A"]);
              const staged = run(["diff", "--cached", "--name-only"]).split("\n").map((s) => s.trim()).filter(Boolean);
              const stat = run(["diff", "--cached", "--stat"]).trim();
              const msg = (ctx.input.commitMessage && ctx.input.commitMessage.trim()) ||
                `gated change: ${ctx.input.workPrompt.split("\n")[0].slice(0, 72)}`;
              let commitHash;
              if (staged.length > 0) {
                run(["commit", "-m", msg]);
                commitHash = run(["rev-parse", "HEAD"]).trim();
              } else {
                // No staged changes — accept only if the agent itself advanced HEAD past baseline.
                const head = run(["rev-parse", "HEAD"]).trim();
                if (head === baseline.startHead) throw new Error("GATE FAILED: implementation produced no changes.");
                commitHash = head;
              }
              if (!/^[0-9a-f]{7,40}$/.test(commitHash)) throw new Error("GATE FAILED: no sane commit hash.");
              return { commit: commitHash, message: msg, stat, files: staged };
            }}
          </Task>
        )}

        {/* 4. GATE: push to origin. */}
        {commit && (
          <Task id="push" output={outputs.push} retries={1}>
            {async () => {
              const { execFileSync } = await import("node:child_process");
              const branch = ctx.input.targetBranch || "main";
              // origin resolves via ~/.ssh/config (github -> id_ed25519_github); no GIT_SSH_COMMAND override here.
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

        {/* 5. Deploy (or report what would deploy). */}
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
