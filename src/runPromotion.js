import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TERMINAL_SUCCESS = new Set(["succeeded", "recovered", "approved"]);

function cleanString(value) {
  return String(value ?? "").trim();
}

function outputNode(run, nodeId) {
  return run?.output?.outputs?.[nodeId] || null;
}

function parseLease(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function defaultWorktreeRoot(env = process.env) {
  return path.resolve(env.RUNYARD_REPO_WORKTREE_DIR || path.join(os.tmpdir(), "runyard-worktrees"));
}

function safeRealpath(value) {
  try {
    return realpathSync(value);
  } catch {
    return "";
  }
}

function isSafeGitBranch(branch) {
  const value = cleanString(branch);
  if (!value || value.length > 240) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.toLowerCase().startsWith("refs/")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  if (/[~^:?*[\]\\\s\x00-\x1f\x7f]/.test(value)) return false;
  return value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

function isSafeRunyardBranch(branch) {
  return isSafeGitBranch(branch) && /^runyard\/[a-z0-9._/-]+\/run_[a-z0-9][a-z0-9._/-]*$/i.test(branch);
}

function assertSafeRunyardBranch(branch) {
  if (!isSafeRunyardBranch(branch)) {
    throw new Error(`promotion blocked: '${branch}' is not a Runyard isolated work branch`);
  }
}

function assertSafeTargetBranch(branch) {
  if (!isSafeGitBranch(branch)) {
    throw new Error(`promotion blocked: '${branch}' is not a safe git target branch`);
  }
}

function runGit(args, { cwd, env, maxBuffer = 1024 * 1024 * 16 }) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer }).trim();
}

function commandErrorMessage(error, fallback = "command failed") {
  const stderr = cleanString(error?.stderr);
  const stdout = cleanString(error?.stdout);
  const message = cleanString(error?.message || fallback);
  const detail = [stderr, stdout].filter(Boolean).join("\n").trim();
  if (!detail) return message;
  const tail = detail.split("\n").slice(-80).join("\n");
  return `${message}\n${tail}`;
}

function runTool(cmd, args, { cwd, env, maxBuffer = 1024 * 1024 * 64 }) {
  try {
    return execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer }).trim();
  } catch (error) {
    throw new Error(commandErrorMessage(error, `${cmd} ${args.join(" ")} failed`));
  }
}

function packageScripts(repoDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoDir, "package.json"), "utf8"));
    return pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  } catch {
    return {};
  }
}

function promotionGateEnv(env = process.env) {
  const next = { ...env, NODE_ENV: "test" };
  for (const key of Object.keys(next)) {
    if (/TOKEN|SECRET|API_KEY|PRIVATE_KEY|WEBHOOK/i.test(key)) delete next[key];
  }
  return next;
}

export function runPromotionCandidate(run, { env = process.env } = {}) {
  const baseline = outputNode(run, "baseline");
  const push = outputNode(run, "push");
  const lease = parseLease(baseline?.lease);
  const sourceBranch = cleanString(push?.branch || lease.pushBranch || lease.workBranch);
  const targetBranch = cleanString(run?.input?.targetBranch || lease.targetBranch || "main") || "main";
  const sourceRepoDir = cleanString(lease.sourceRepoDir);
  const workRepoDir = cleanString(lease.workRepoDir || baseline?.repoDir || baseline?.repo_dir || lease.repoDir);
  const mode = cleanString(run?.input?.mutationMode || lease.mode);
  const alreadyPromoted = Boolean(run?.output?.promotion?.merged);

  const worktreeRoot = defaultWorktreeRoot(env);
  const realWorkRepo = safeRealpath(workRepoDir);
  const realWorktreeRoot = safeRealpath(worktreeRoot) || worktreeRoot;
  const worktreeInsideRoot = Boolean(realWorkRepo && realWorkRepo.startsWith(`${realWorktreeRoot}${path.sep}`));
  const safeSourceBranch = isSafeRunyardBranch(sourceBranch);
  const safeTargetBranch = isSafeGitBranch(targetBranch);

  const available = Boolean(
    run?.id
    && TERMINAL_SUCCESS.has(run.status)
    && !alreadyPromoted
    && mode === "parallel"
    && sourceBranch
    && targetBranch
    && sourceRepoDir
    && workRepoDir
    && worktreeInsideRoot
    && safeSourceBranch
    && safeTargetBranch
  );

  return {
    available,
    reason: available
      ? ""
      : alreadyPromoted
        ? "already promoted"
        : mode !== "parallel"
          ? "run was not produced in isolated worktree mode"
          : !TERMINAL_SUCCESS.has(run?.status)
            ? "run is not successful"
            : !safeSourceBranch
              ? "invalid isolated branch metadata"
              : !safeTargetBranch
                ? "invalid target branch metadata"
                : "missing isolated branch/worktree metadata",
    sourceBranch,
    targetBranch,
    sourceRepoDir,
    workRepoDir,
    mode
  };
}

export function promoteRunToMain(run, {
  env = process.env,
  gates = true,
  gitEnv = process.env,
  pnpmBin = process.env.PNPM_PATH || process.env.GATED_PNPM_BIN || "pnpm"
} = {}) {
  const candidate = runPromotionCandidate(run, { env });
  if (!candidate.available) throw new Error(`promotion unavailable: ${candidate.reason}`);
  assertSafeRunyardBranch(candidate.sourceBranch);
  assertSafeTargetBranch(candidate.targetBranch);

  const repoDir = realpathSync(candidate.sourceRepoDir);
  const workRepoDir = realpathSync(candidate.workRepoDir);
  const worktreeRoot = safeRealpath(defaultWorktreeRoot(env)) || defaultWorktreeRoot(env);
  if (!workRepoDir.startsWith(`${worktreeRoot}${path.sep}`)) {
    throw new Error("promotion blocked: worktree is outside RUNYARD_REPO_WORKTREE_DIR");
  }

  const toolEnv = { ...gitEnv, PATH: [gitEnv.PATH || "", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":") };
  const beforeHead = runGit(["rev-parse", "HEAD"], { cwd: repoDir, env: toolEnv });
  const currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, env: toolEnv });
  const dirty = runGit(["status", "--porcelain=v1"], { cwd: repoDir, env: toolEnv });
  if (dirty) throw new Error(`promotion blocked: target checkout is dirty:\n${dirty.split("\n").slice(0, 20).join("\n")}`);

  let mergeHead = "";
  let merged = false;
  try {
    runGit(["fetch", "origin", candidate.targetBranch, candidate.sourceBranch], { cwd: repoDir, env: toolEnv });
    runGit(["checkout", candidate.targetBranch], { cwd: repoDir, env: toolEnv });
    runGit(["pull", "--ff-only", "origin", candidate.targetBranch], { cwd: repoDir, env: toolEnv });
    runGit(["merge", "--no-ff", "--no-edit", candidate.sourceBranch], { cwd: repoDir, env: toolEnv });
    merged = true;

    const scripts = gates ? packageScripts(repoDir) : {};
    const gateEnv = promotionGateEnv(toolEnv);
    if (scripts.test) runTool(pnpmBin, ["test"], { cwd: repoDir, env: gateEnv });
    if (scripts.build) runTool(pnpmBin, ["build"], { cwd: repoDir, env: gateEnv });
    runGit(["diff", "--check"], { cwd: repoDir, env: toolEnv });

    mergeHead = runGit(["rev-parse", "HEAD"], { cwd: repoDir, env: toolEnv });
    runGit(["push", "origin", `HEAD:${candidate.targetBranch}`], { cwd: repoDir, env: toolEnv });

    // Cleanup happens only after target push succeeds. If cleanup fails, the
    // merge is still valid and the operator can retry cleanup manually.
    const cleanup = [];
    try {
      runGit(["worktree", "remove", "--force", workRepoDir], { cwd: repoDir, env: toolEnv });
      cleanup.push("worktree");
    } catch (error) {
      cleanup.push(`worktree cleanup failed: ${String(error.stderr || error.message || error).slice(0, 300)}`);
    }
    try {
      runGit(["branch", "-D", candidate.sourceBranch], { cwd: repoDir, env: toolEnv });
      cleanup.push("local branch");
    } catch (error) {
      cleanup.push(`local branch cleanup skipped: ${String(error.stderr || error.message || error).slice(0, 300)}`);
    }
    try {
      runGit(["push", "origin", "--delete", candidate.sourceBranch], { cwd: repoDir, env: toolEnv });
      cleanup.push("remote branch");
    } catch (error) {
      cleanup.push(`remote branch cleanup skipped: ${String(error.stderr || error.message || error).slice(0, 300)}`);
    }

    return {
      merged: true,
      sourceBranch: candidate.sourceBranch,
      targetBranch: candidate.targetBranch,
      mergeCommit: mergeHead,
      cleanup,
      promotedAt: new Date().toISOString()
    };
  } catch (error) {
    try {
      runGit(["merge", "--abort"], { cwd: repoDir, env: toolEnv });
    } catch {
      // No active merge, or abort failed because the failure happened after merge.
    }
    if (merged) {
      try {
        runGit(["reset", "--hard", `origin/${candidate.targetBranch}`], { cwd: repoDir, env: toolEnv });
      } catch {
        // Surface the original failure; the dirty-check on the next attempt will
        // force operator review if cleanup did not restore the target checkout.
      }
    }
    if (!merged) {
      try {
        runGit(["checkout", currentBranch], { cwd: repoDir, env: toolEnv });
        runGit(["reset", "--hard", beforeHead], { cwd: repoDir, env: toolEnv });
      } catch {
        // Best-effort restoration only. The next attempt re-checks cleanliness.
      }
    }
    throw new Error(commandErrorMessage(error).slice(0, 6000));
  }
}
