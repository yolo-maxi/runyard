import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_WAIT_MS = 30 * 60 * 1000;

function cleanString(value) {
  return String(value ?? "").trim();
}

function runGit(gitBin, args, { cwd, env }) {
  return execFileSync(gitBin, args, { cwd, env, encoding: "utf8" }).trim();
}

function runGitRaw(gitBin, args, { cwd, env }) {
  return execFileSync(gitBin, args, { cwd, env, encoding: "utf8" });
}

function hashKey(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function safeSegment(value, fallback = "run") {
  const clean = cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return clean || fallback;
}

export function isSafeGitBranch(branch) {
  const value = cleanString(branch);
  if (!value || value.length > 240) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.toLowerCase().startsWith("refs/")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  if (/[~^:?*[\]\\\s\x00-\x1f\x7f]/.test(value)) return false;
  return value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

function assertSafeTargetBranch(branch) {
  if (!isSafeGitBranch(branch)) {
    throw new Error(`REPO LEASE BLOCKED: target branch is not a safe git branch: ${branch}`);
  }
}

function runIdFromEnv(env = process.env) {
  return cleanString(env.RUNYARD_RUN_ID || env.SMITHERS_HUB_RUN_ID || env.SMITHERS_RUN_ID || env.RUN_ID) || `pid-${process.pid}`;
}

function leaseRoot(env = process.env) {
  return path.resolve(env.RUNYARD_REPO_LEASE_DIR || path.join(os.tmpdir(), "runyard-repo-leases"));
}

function worktreeRoot(env = process.env) {
  return path.resolve(env.RUNYARD_REPO_WORKTREE_DIR || path.join(os.tmpdir(), "runyard-worktrees"));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function gitStatusFiles(repoDir, { gitBin = "git", gitEnv = process.env } = {}) {
  const raw = runGitRaw(gitBin, ["status", "--porcelain=v1", "-z"], { cwd: repoDir, env: gitEnv });
  return raw
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3).trim() || entry.trim());
}

export function assertCleanWorkingTree(repoDir, { gitBin = "git", gitEnv = process.env, label = "working tree" } = {}) {
  const dirtyFiles = gitStatusFiles(repoDir, { gitBin, gitEnv });
  if (dirtyFiles.length) {
    throw new Error(
      `REPO LEASE BLOCKED: ${label} is not clean. ` +
        `Operator action required before mutating workflow can start. Dirty files: ${dirtyFiles.slice(0, 20).join(", ")}`
    );
  }
}

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function readLease(lockDir) {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, "lease.json"), "utf8"));
  } catch {
    return null;
  }
}

function removeStaleLease(lockDir, env) {
  const lease = readLease(lockDir);
  if (lease?.pid && !processAlive(lease.pid)) {
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  }
  const staleMs = Math.max(0, Number(env.RUNYARD_REPO_LEASE_STALE_MS || 0));
  if (staleMs > 0) {
    try {
      const age = Date.now() - statSync(lockDir).mtimeMs;
      if (age > staleMs) {
        rmSync(lockDir, { recursive: true, force: true });
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function leasePaths(repoDir, targetBranch, env) {
  const repoPath = realpathSync(repoDir);
  const key = hashKey(`${repoPath}\0${targetBranch}`);
  return {
    root: leaseRoot(env),
    lockDir: path.join(leaseRoot(env), `${key}.lock`),
    key,
    repoPath
  };
}

export function releaseRepoLease(lease, { env = process.env } = {}) {
  if (!lease?.lockDir || !lease?.leaseId) return false;
  const current = readLease(lease.lockDir);
  if (current?.leaseId !== lease.leaseId) return false;
  rmSync(lease.lockDir, { recursive: true, force: true });
  return true;
}

export function releaseRunRepoLeases(runId, { env = process.env } = {}) {
  const targetRunId = cleanString(runId);
  if (!targetRunId) return 0;
  const root = leaseRoot(env);
  let released = 0;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lock")) continue;
    const lockDir = path.join(root, entry.name);
    const lease = readLease(lockDir);
    if (lease?.runId !== targetRunId || !lease?.leaseId) continue;
    rmSync(lockDir, { recursive: true, force: true });
    released += 1;
  }
  return released;
}

export function acquireRepoLease({
  repoDir,
  targetBranch = "main",
  workflow = "mutating-workflow",
  gitBin = "git",
  gitEnv = process.env,
  env = process.env
} = {}) {
  const branch = cleanString(targetBranch) || "main";
  assertSafeTargetBranch(branch);
  const { root, lockDir, key, repoPath } = leasePaths(repoDir, branch, env);
  mkdirSync(root, { recursive: true });
  const runId = runIdFromEnv(env);
  const leaseId = `${runId}-${process.pid}-${Date.now()}`;
  const waitMs = Math.max(0, Number(env.RUNYARD_REPO_LEASE_WAIT_MS ?? DEFAULT_WAIT_MS));
  const deadline = Date.now() + waitMs;

  while (true) {
    let createdLockDir = false;
    try {
      mkdirSync(lockDir);
      createdLockDir = true;
      const startHead = runGit(gitBin, ["rev-parse", "HEAD"], { cwd: repoPath, env: gitEnv });
      const startBranch = runGit(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, env: gitEnv });
      assertCleanWorkingTree(repoPath, { gitBin, gitEnv, label: `repo ${repoPath}` });
      const lease = {
        schemaVersion: 1,
        mode: "sequential",
        leaseId,
        runId,
        pid: process.pid,
        workflow,
        repoDir: repoPath,
        targetBranch: branch,
        startBranch,
        startHead,
        key,
        lockDir,
        acquiredAt: new Date().toISOString()
      };
      writeFileSync(path.join(lockDir, "lease.json"), JSON.stringify(lease, null, 2));
      return lease;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (createdLockDir) rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      if (createdLockDir) rmSync(lockDir, { recursive: true, force: true });
      if (removeStaleLease(lockDir, env)) continue;
      const holder = readLease(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(
          `REPO LEASE WAITING: ${workflow} cannot edit ${repoPath} target ${branch}; ` +
            `lease is held by run ${holder?.runId || "unknown"} (${holder?.leaseId || "unknown"}).`
        );
      }
      sleepSync(Math.min(1000, Math.max(100, deadline - Date.now())));
    }
  }
}

function assertLeaseOwner(lease) {
  const current = readLease(lease.lockDir);
  if (!current || current.leaseId !== lease.leaseId) {
    throw new Error(
      `REPO LEASE LOST: expected lease ${lease.leaseId} for ${lease.repoDir} target ${lease.targetBranch}. ` +
        "Stop and ask an operator to inspect the checkout before continuing."
    );
  }
}

export function validateBeforeCommit(lease, { gitBin = "git", gitEnv = process.env } = {}) {
  if (lease?.mode !== "sequential") return;
  assertLeaseOwner(lease);
  const branch = runGit(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: lease.repoDir, env: gitEnv });
  if (branch !== lease.startBranch) throw new Error(`GATE FAILED: branch changed from ${lease.startBranch} to ${branch}.`);
  const head = runGit(gitBin, ["rev-parse", "HEAD"], { cwd: lease.repoDir, env: gitEnv });
  if (head !== lease.startHead) throw new Error(`GATE FAILED: HEAD moved unexpectedly from ${lease.startHead} to ${head}.`);
}

export function validateBeforePush(lease, expectedHead, { gitBin = "git", gitEnv = process.env } = {}) {
  if (lease?.mode === "sequential") assertLeaseOwner(lease);
  const repoDir = lease?.repoDir;
  const branch = runGit(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, env: gitEnv });
  if (lease?.startBranch && branch !== lease.startBranch) throw new Error(`GATE FAILED: branch changed from ${lease.startBranch} to ${branch}.`);
  const head = runGit(gitBin, ["rev-parse", "HEAD"], { cwd: repoDir, env: gitEnv });
  if (expectedHead && head !== expectedHead) throw new Error(`GATE FAILED: HEAD moved unexpectedly from ${expectedHead} to ${head}.`);
  assertCleanWorkingTree(repoDir, { gitBin, gitEnv, label: `repo ${repoDir}` });
}

export function prepareMutatingRepo({
  repoDir,
  targetBranch = "main",
  workflow = "mutating-workflow",
  mode = "sequential",
  gitBin = "git",
  gitEnv = process.env,
  env = process.env
} = {}) {
  const requestedMode = cleanString(mode) || "sequential";
  const branch = cleanString(targetBranch) || "main";
  assertSafeTargetBranch(branch);
  if (requestedMode !== "parallel") {
    const lease = acquireRepoLease({ repoDir, targetBranch: branch, workflow, gitBin, gitEnv, env });
    return { ...lease, workRepoDir: lease.repoDir, workBranch: lease.startBranch, pushBranch: branch };
  }

  const canonicalRepo = realpathSync(repoDir);
  const runId = runIdFromEnv(env);
  const startHead = runGit(gitBin, ["rev-parse", "HEAD"], { cwd: canonicalRepo, env: gitEnv });
  const sourceBranch = runGit(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: canonicalRepo, env: gitEnv });
  const workBranch = safeSegment(`runyard/${workflow}/${branch}/${runId}`, `runyard/${runId}`);
  runGit(gitBin, ["check-ref-format", "--branch", workBranch], { cwd: canonicalRepo, env: gitEnv });
  const dirName = `${path.basename(canonicalRepo)}-${safeSegment(runId, "run")}-${hashKey(workBranch)}`;
  const workRepoDir = path.join(worktreeRoot(env), dirName);
  if (existsSync(workRepoDir)) {
    throw new Error(`PARALLEL WORKTREE BLOCKED: worktree path already exists: ${workRepoDir}`);
  }
  mkdirSync(path.dirname(workRepoDir), { recursive: true });
  runGit(gitBin, ["worktree", "add", "-b", workBranch, workRepoDir, startHead], { cwd: canonicalRepo, env: gitEnv });
  assertCleanWorkingTree(workRepoDir, { gitBin, gitEnv, label: `parallel worktree ${workRepoDir}` });
  return {
    schemaVersion: 1,
    mode: "parallel",
    leaseId: "",
    runId,
    pid: process.pid,
    workflow,
    repoDir: workRepoDir,
    sourceRepoDir: canonicalRepo,
    targetBranch: branch,
    startBranch: workBranch,
    sourceBranch,
    startHead,
    workRepoDir,
    workBranch,
    pushBranch: workBranch,
    acquiredAt: new Date().toISOString()
  };
}
