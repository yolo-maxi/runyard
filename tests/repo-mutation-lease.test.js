import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireRepoLease,
  isSafeGitBranch,
  prepareMutatingRepo,
  releaseRepoLease,
  releaseRunRepoLeases,
  validateBeforeCommit,
  validateBeforePush
} from "../workflow-templates/workflows/repo-mutation-lease.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "runyard-repo-lease-"));

after(() => {
  rmSync(temp, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: process.env, encoding: "utf8" }).trim();
}

function initRepo(name) {
  const repoDir = path.join(temp, name);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "init"]);
  return repoDir;
}

function leaseEnv(name, extras = {}) {
  return {
    ...process.env,
    RUNYARD_RUN_ID: `run_${name}`,
    RUNYARD_REPO_LEASE_DIR: path.join(temp, "leases", name),
    RUNYARD_REPO_WORKTREE_DIR: path.join(temp, "worktrees", name),
    RUNYARD_REPO_LEASE_WAIT_MS: "0",
    ...extras
  };
}

describe("repo mutation leases", () => {
  it("acquires and releases a sequential repo/branch lease", () => {
    const repoDir = initRepo("sequential");
    const env = leaseEnv("sequential");

    const lease = acquireRepoLease({ repoDir, targetBranch: "main", workflow: "test", env });

    assert.equal(lease.mode, "sequential");
    assert.equal(lease.repoDir, realpathSync(repoDir));
    assert.equal(lease.targetBranch, "main");
    assert.ok(existsSync(lease.lockDir));
    assert.equal(releaseRepoLease(lease, { env }), true);
    assert.equal(existsSync(lease.lockDir), false);
  });

  it("blocks a second sequential writer for the same repo and branch", () => {
    const repoDir = initRepo("contended");
    const env = leaseEnv("contended");
    const first = acquireRepoLease({ repoDir, targetBranch: "main", workflow: "first", env });

    assert.throws(
      () => acquireRepoLease({ repoDir, targetBranch: "main", workflow: "second", env: { ...env, RUNYARD_RUN_ID: "run_second" } }),
      /REPO LEASE WAITING/
    );

    releaseRepoLease(first, { env });
  });

  it("releases all sequential leases for a terminal runner run", () => {
    const repoDir = initRepo("cleanup");
    const env = leaseEnv("cleanup");
    const lease = acquireRepoLease({ repoDir, targetBranch: "main", workflow: "test", env });

    assert.equal(existsSync(lease.lockDir), true);
    assert.equal(releaseRunRepoLeases("run_cleanup", { env }), 1);
    assert.equal(existsSync(lease.lockDir), false);
  });

  it("refuses to start a mutating lease on a dirty checkout", () => {
    const repoDir = initRepo("dirty");
    const env = leaseEnv("dirty");
    writeFileSync(path.join(repoDir, "README.md"), "# dirty\n");

    assert.throws(
      () => acquireRepoLease({ repoDir, targetBranch: "main", workflow: "dirty", env }),
      /not clean.*README\.md/
    );

    git(repoDir, ["checkout", "--", "README.md"]);
    const lease = acquireRepoLease({ repoDir, targetBranch: "main", workflow: "dirty-clean-retry", env });
    assert.equal(lease.mode, "sequential");
    releaseRepoLease(lease, { env });
  });

  it("rejects unsafe target branch names before git operations", () => {
    const repoDir = initRepo("unsafe-branch");
    const env = leaseEnv("unsafe-branch");

    assert.equal(isSafeGitBranch("main"), true);
    assert.equal(isSafeGitBranch("release/v1.2"), true);
    assert.equal(isSafeGitBranch("--upload-pack=/tmp/evil"), false);
    assert.equal(isSafeGitBranch("refs/tags/v1"), false);
    assert.equal(isSafeGitBranch("feature;restart"), false);

    assert.throws(
      () => acquireRepoLease({ repoDir, targetBranch: "--upload-pack=/tmp/evil", workflow: "unsafe", env }),
      /target branch is not a safe git branch/
    );
    assert.throws(
      () => prepareMutatingRepo({ repoDir, targetBranch: "feature with space", workflow: "unsafe", mode: "parallel", env }),
      /target branch is not a safe git branch/
    );
  });

  it("detects unexpected HEAD movement before commit", () => {
    const repoDir = initRepo("head-moved");
    const env = leaseEnv("head-moved");
    const lease = acquireRepoLease({ repoDir, targetBranch: "main", workflow: "test", env });
    writeFileSync(path.join(repoDir, "later.txt"), "later\n");
    git(repoDir, ["add", "later.txt"]);
    git(repoDir, ["commit", "-m", "external"]);

    assert.throws(() => validateBeforeCommit(lease), /HEAD moved unexpectedly/);

    releaseRepoLease(lease, { env });
  });

  it("creates an explicit parallel worktree with a unique push branch", () => {
    const repoDir = initRepo("parallel");
    const prepared = prepareMutatingRepo({
      repoDir,
      targetBranch: "main",
      workflow: "implement-change-gated",
      mode: "parallel",
      env: leaseEnv("parallel")
    });

    assert.equal(prepared.mode, "parallel");
    assert.notEqual(prepared.workRepoDir, repoDir);
    assert.match(prepared.pushBranch, /^runyard\/implement-change-gated\/main\/run_parallel/);
    assert.equal(git(prepared.workRepoDir, ["rev-parse", "--abbrev-ref", "HEAD"]), prepared.pushBranch);
    validateBeforePush(prepared, prepared.startHead);
  });
});
