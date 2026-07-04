// smithers-source: authored
// smithers-display-name: Implement Change (gated)
// smithers-description: Runs an implementation agent for a change request, then gates it (pnpm install --frozen-lockfile, pnpm test, staged diff, a sane commit, push to origin). The run stops after push; production deploys are admin-configured post-run hooks, never an implicit workflow step.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, CodexAgent, ClaudeCodeAgent, PiAgent } from "smithers-orchestrator";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod/v4";
import { resolveImproveRepo } from "./improve-repo.js";
import { withAgentFallback } from "./agent-fallback.js";
import { createPiAgentFromEnv, resolveAgentCli } from "./pi-harness.js";
import { prepareMutatingRepo, releaseRepoLease, validateBeforeCommit, validateBeforePush } from "./repo-mutation-lease.js";

// Repo is deployment-specific; set env vars on your runner. The old
// GATED_PROD_* deploy target moved behind admin-configured post-run hook
// profiles (see docs/design/post-run-hooks.md).
function resolveTool(envName, fallback, candidates) {
  const configured = process.env[envName];
  if (configured) return configured;
  return candidates.find((candidate) => existsSync(candidate)) || fallback;
}
const GIT = resolveTool("GATED_GIT_BIN", "git", ["/usr/bin/git", "/usr/local/bin/git"]);
// pnpm is resolved per-run inside the test task via resolvePnpmOrExplain() so that
// a missing pnpm fails fast with a guided remediation message instead of a raw
// ENOENT trace. GATED_PNPM_BIN and PNPM_PATH are honoured there.
const TOOL_PATH = [
  process.env.PATH || "",
  "/usr/local/bin",
  "/usr/bin",
  "/bin"
].filter(Boolean).join(":");
const TOOL_ENV = { ...process.env, PATH: TOOL_PATH };

// Distinct exit-style code so callers can distinguish lockfile drift from a real
// test failure. We thread it via Error.code so the orchestrator surfaces it on
// the run summary instead of getting buried in a generic GATE FAILED tail.
const LOCKFILE_DRIFT_CODE = "LOCKFILE_DRIFT";

function slugifyChangeRequest(input) {
  const explicit = (input && input.changeRequestId && String(input.changeRequestId).trim()) || "";
  const source = explicit || String(input?.workPrompt || "").split("\n")[0] || "change";
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "change";
}

async function resolvePnpmOrExplain() {
  // Honour explicit overrides first (both the workflow-specific GATED_PNPM_BIN and
  // the more conventional PNPM_PATH that ops runbooks tend to mention), then fall
  // back to the well-known absolute paths, and finally PATH lookup via `command -v`.
  const tried = [];
  const candidates = [];
  if (process.env.PNPM_PATH) candidates.push(process.env.PNPM_PATH);
  if (process.env.GATED_PNPM_BIN) candidates.push(process.env.GATED_PNPM_BIN);
  candidates.push("/usr/local/bin/pnpm", "/usr/bin/pnpm");
  for (const c of candidates) {
    tried.push(c);
    if (existsSync(c)) return c;
  }
  const { spawnSync } = await import("node:child_process");
  const which = spawnSync("sh", ["-c", "command -v pnpm"], { env: TOOL_ENV, encoding: "utf8" });
  if (which.status === 0 && which.stdout && which.stdout.trim()) return which.stdout.trim();
  throw new Error(
    `pnpm not found in PATH or [${tried.join(", ")}]. ` +
      "Set PNPM_PATH=/abs/path/to/pnpm in runner.env, or install via `npm i -g pnpm`."
  );
}

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
  repoDir: z.string(),
  targetBranch: z.string(),
  lease: repoLeaseOut
});
const implementOut = z.looseObject({ summary: z.string().default(""), notes: z.string().default("") });
const testOut = z.looseObject({ passed: z.boolean(), tail: z.string().default("") });
const commitOut = z.looseObject({ commit: z.string(), message: z.string(), stat: z.string().default(""), files: z.array(z.string()).default([]) });
const pushOut = z.looseObject({ pushed: z.boolean(), branch: z.string(), detail: z.string().default("") });
// Post-run hook reporting node: status uses the shared hook vocabulary
// (skipped / hook_config_required / ...). Hook problems are reported, never
// thrown — they must not fail a gated run whose build/tests/push succeeded.
const hooksOut = z.looseObject({ status: z.string().default("skipped"), detail: z.string().default(""), verify: z.string().default("") });

const inputSchema = z.object({
  workPrompt: z.string().describe("The change request / implementation prompt."),
  deploy: z.boolean().optional().describe("Deprecated; production deploys moved to admin-configured post-run hook profiles. deploy=true no longer deploys — it is reported as hook_config_required."),
  targetBranch: z.string().default("main"),
  commitMessage: z.string().default(""),
  changeRequestId: z.string().default("").describe("Optional change-request id/slug stamped into the auto-commit subject."),
  allowLockfileUpdate: z.boolean().default(false).describe("If true, the install gate runs `pnpm install` (no --frozen-lockfile) so an added dependency can regenerate pnpm-lock.yaml."),
  repoDir: z.string().default("").describe("Absolute runner-local git repo path to edit. Must be inside allowed improve repo roots."),
  repo: z.string().default("").describe("Optional friendly repo key resolved on the runner from IMPROVE_REPO_MAP JSON."),
  project: z.string().default("").describe("Optional friendly project key resolved from IMPROVE_PROJECT_MAP or IMPROVE_REPO_MAP."),
  mutationMode: z
    .enum(["sequential", "parallel"])
    .default("parallel")
    .describe("Mutating checkout mode. parallel creates a unique branch/worktree and requires a later Hub promotion; sequential takes a repo/branch lease and pushes directly.")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  baseline: baselineOut,
  implement: implementOut,
  test: testOut,
  commit: commitOut,
  push: pushOut,
  hooks: hooksOut
});

const IMPLEMENT_AGENT_CLI = resolveAgentCli(process.env, { workflow: "IMPLEMENT", fallback: "codex" });

function createBuilder(repoDir) {
  const systemPrompt =
    "You are an implementation agent working inside a git repository. Make the requested change with tight, idiomatic edits that match the surrounding code. " +
    "Do NOT git commit, git push, or deploy, and do NOT run the test suite — a separate gated pipeline runs tests, commits, pushes, and deploys. Keep changes scoped; do not touch unrelated files.";
  const claude = new ClaudeCodeAgent({
    model:
      process.env.RUNYARD_IMPLEMENT_CLAUDE_MODEL ||
      (IMPLEMENT_AGENT_CLI === "claude" ? process.env.RUNYARD_IMPLEMENT_AGENT_MODEL : "") ||
      "claude-opus-4-7",
    cwd: repoDir,
    dangerouslySkipPermissions: true,
    timeoutMs: 45 * 60 * 1000,
    systemPrompt
  });
  const codex = new CodexAgent({
    ...(process.env.RUNYARD_IMPLEMENT_CODEX_MODEL
      ? { model: process.env.RUNYARD_IMPLEMENT_CODEX_MODEL }
      : IMPLEMENT_AGENT_CLI !== "claude" && process.env.RUNYARD_IMPLEMENT_AGENT_MODEL
        ? { model: process.env.RUNYARD_IMPLEMENT_AGENT_MODEL }
        : {}),
    cwd: repoDir,
    sandbox: "danger-full-access",
    nativeStructuredOutput: true,
    timeoutMs: 45 * 60 * 1000,
    systemPrompt
  });
  const cliPair =
    IMPLEMENT_AGENT_CLI === "claude"
      ? withAgentFallback(claude, codex, { label: "implement-change-gated" })
      : withAgentFallback(codex, claude, { label: "implement-change-gated" });
  if (IMPLEMENT_AGENT_CLI !== "pi") return cliPair;
  const pi = createPiAgentFromEnv({
    PiAgent,
    workflow: "IMPLEMENT",
    cwd: repoDir,
    systemPrompt,
    timeoutMs: 45 * 60 * 1000
  });
  return withAgentFallback(pi, cliPair, { label: "implement-change-gated" });
}

export default smithers((ctx) => {
  // Collapse the friendly selector to a single field so resolveImproveRepo doesn't reject
  // callers that fill in both `repo` and `project` (e.g. an alias pair) with different values.
  const improveInput = {
    ...ctx.input,
    repo: ctx.input.repoDir ? "" : ctx.input.repo || ctx.input.project,
    project: ""
  };
  const repoDir = resolveImproveRepo(improveInput, { env: process.env, cwd: process.cwd(), gitBin: GIT, gitEnv: TOOL_ENV });
  const baseline = ctx.outputMaybe("baseline", { nodeId: "baseline" });
  const workRepoDir = baseline?.repoDir || repoDir;
  const builder = baseline ? createBuilder(workRepoDir) : null;
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
            const lease = prepareMutatingRepo({
              repoDir,
              targetBranch: ctx.input.targetBranch || "main",
              workflow: "implement-change-gated",
              mode: ctx.input.mutationMode || "sequential",
              gitBin: GIT,
              gitEnv: TOOL_ENV,
              env: process.env
            });
            return { startHead: lease.startHead, repoDir: lease.workRepoDir || lease.repoDir, targetBranch: lease.pushBranch, lease };
          }}
        </Task>

        {/* 1. Implementation agent makes the change (edits only). */}
        {baseline && (
          <Task id="implement" output={outputs.implement} agent={builder} timeoutMs={45 * 60 * 1000}>
            {`Implement this change request in the repository at ${workRepoDir}. Edit files only — do not commit, push, deploy, or run tests.\n\n` +
              `RUN LEASE: mode=${baseline.lease?.mode || "sequential"} runId=${baseline.lease?.runId || "unknown"} targetBranch=${baseline.targetBranch || ctx.input.targetBranch || "main"}. ` +
              `If the checkout is dirty before you edit, HEAD changes unexpectedly, or another lease appears to own this repo, stop and report the operator action instead of working around it.\n\n` +
              `=== CHANGE REQUEST ===\n${ctx.input.workPrompt}\n=== END ===\n\n` +
              `When finished, return JSON {"summary": <what you changed>, "notes": <risks/tradeoffs>}.`}
          </Task>
        )}

        {/* 2. GATE: install + pnpm test must pass, or the run fails here (nothing committed/pushed/deployed). */}
        {impl && (
          <Task id="test" output={outputs.test} retries={0}>
            {async () => {
              const { spawnSync } = await import("node:child_process");
              // 256MB — large, but spawnSync will silently truncate at the cap, so we
              // detect that explicitly below instead of letting a confusing mid-log tail leak.
              const MAX_BUFFER = 256 * 1024 * 1024;
              const TRUNCATION_BANNER =
                "\n— output truncated at 256MB; rerun locally with `pnpm test` for full log —\n";

              // Pre-flight: fail fast with a guided message when pnpm cannot be located.
              const pnpm = await resolvePnpmOrExplain();

              // 1. Install gate. --frozen-lockfile by default so an agent that edits package.json
              // without updating pnpm-lock.yaml is caught with a clear remediation instead of
              // a 30-line pnpm trace. allowLockfileUpdate=true regenerates the lockfile.
              const installArgs = ctx.input.allowLockfileUpdate ? ["install"] : ["install", "--frozen-lockfile"];
              const installResult = spawnSync(pnpm, installArgs, {
                cwd: workRepoDir,
                encoding: "utf8",
                env: TOOL_ENV,
                maxBuffer: MAX_BUFFER
              });
              const installOut = `${installResult.stdout ?? ""}${installResult.stderr ?? ""}`;
              if (installResult.status !== 0) {
                if (/ERR_PNPM_OUTDATED_LOCKFILE/.test(installOut)) {
                  const err = new Error(
                    "Lockfile drift detected — rerun this workflow with allowLockfileUpdate=true to regenerate pnpm-lock.yaml"
                  );
                  err.code = LOCKFILE_DRIFT_CODE;
                  throw err;
                }
                const installTail = installOut.split("\n").slice(-30).join("\n");
                throw new Error(`GATE FAILED: pnpm ${installArgs.join(" ")} failed.\n${installTail}`);
              }

              // 2. Test gate. Use spawnSync (not execFileSync) so we can inspect maxBuffer
              // truncation without try/catching for ENOBUFS in a separate code path.
              const testResult = spawnSync(pnpm, ["test"], {
                cwd: workRepoDir,
                encoding: "utf8",
                env: TOOL_ENV,
                maxBuffer: MAX_BUFFER
              });
              const rawStdout = testResult.stdout ?? "";
              const rawStderr = testResult.stderr ?? "";
              let combined = `${rawStdout}${rawStderr}${testResult.error?.message ?? ""}`;
              const truncated =
                testResult.error?.code === "ENOBUFS" ||
                (typeof rawStdout === "string" && rawStdout.length >= MAX_BUFFER) ||
                (typeof rawStderr === "string" && rawStderr.length >= MAX_BUFFER);
              if (truncated) combined += TRUNCATION_BANNER;
              const tail = String(combined || "").split("\n").slice(-30).join("\n");
              const passed = testResult.status === 0 && !testResult.error;
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
              const lease = baseline.lease;
              validateBeforeCommit(lease, { gitBin: GIT, gitEnv: TOOL_ENV });
              const run = (args) => execFileSync(GIT, args, { cwd: workRepoDir, encoding: "utf8", env: TOOL_ENV });
              run(["add", "-A"]);
              const staged = run(["diff", "--cached", "--name-only"]).split("\n").map((s) => s.trim()).filter(Boolean);
              const stat = run(["diff", "--cached", "--stat"]).trim();
              // Stamp the change-request slug into the subject so `git log --oneline` after
              // a few automated runs is scannable. Cap the slug at 32 chars and budget the
              // remaining subject so the total subject fits in the ~72-char convention.
              const slug = slugifyChangeRequest(ctx.input);
              const subjectPrefix = `[smithers:${slug}] `;
              const remainingSubject = Math.max(20, 72 - subjectPrefix.length);
              const rawMsg = (ctx.input.commitMessage && ctx.input.commitMessage.trim()) ||
                `gated change: ${ctx.input.workPrompt.split("\n")[0].slice(0, remainingSubject)}`;
              const msg = rawMsg.startsWith(subjectPrefix) ? rawMsg : `${subjectPrefix}${rawMsg}`;
              let commitHash;
              if (staged.length > 0) {
                run(["commit", "-m", msg]);
                commitHash = run(["rev-parse", "HEAD"]).trim();
              } else {
                // No staged changes — accept as a no-op rather than failing the gate so a
                // benign "nothing to change" outcome (agent decided no edits were needed,
                // or the request was already satisfied) doesn't sink the whole pipeline.
                // Downstream push/deploy will no-op against the unchanged HEAD.
                commitHash = run(["rev-parse", "HEAD"]).trim();
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
              const branch = baseline.targetBranch || ctx.input.targetBranch || "main";
              if (baseline.lease?.mode === "parallel" && branch === (ctx.input.targetBranch || "main")) {
                throw new Error("PARALLEL MODE BLOCKED: isolated workers may only push their unique work branch.");
              }
              validateBeforePush(baseline.lease, commit.commit, { gitBin: GIT, gitEnv: TOOL_ENV });
              // origin resolves via ~/.ssh/config (github -> id_ed25519_github); no GIT_SSH_COMMAND override here.
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

        {/* 5. Post-run hooks. The run is complete once the branch is pushed;
            production deploys are admin-configured hook profiles, not an
            implicit workflow step. Legacy deploy=true is reported as
            hook_config_required — never executed, never a run failure. */}
        {push && (
          <Task id="hooks" output={outputs.hooks} retries={0}>
            {async () => {
              releaseRepoLease(baseline.lease, { env: process.env });
              if (ctx.input.deploy === true) {
                return {
                  status: "hook_config_required",
                  detail: `deploy=true is deprecated and no longer deploys. Commit ${commit.commit} is pushed; promote/deploy explicitly, or ask an admin to configure a post-run hook profile (runyard hooks).`,
                  verify: "post-run hook configuration required (legacy deploy=true)"
                };
              }
              return { status: "skipped", detail: "no post-run hooks requested", verify: "" };
            }}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
