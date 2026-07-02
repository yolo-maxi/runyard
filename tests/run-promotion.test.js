import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promoteRunToMain, runPromotionCandidate } from "../src/runPromotion.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "runyard-promotion-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const worktrees = path.join(root, "worktrees");
  execFileSync("git", ["init", "--bare", origin], { encoding: "utf8" });
  execFileSync("git", ["clone", origin, repo], { encoding: "utf8" });
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { root, origin, repo, worktrees };
}

function isolatedRun({ repo, worktrees }) {
  const sourceBranch = "runyard/implement-change-gated/main/run_test123";
  const workRepoDir = path.join(worktrees, "repo-run_test123");
  const startHead = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-b", sourceBranch, workRepoDir, startHead]);
  git(workRepoDir, ["config", "user.email", "test@example.com"]);
  git(workRepoDir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(workRepoDir, "feature.txt"), "feature\n");
  git(workRepoDir, ["add", "feature.txt"]);
  git(workRepoDir, ["commit", "-m", "feature"]);
  const commit = git(workRepoDir, ["rev-parse", "HEAD"]);
  git(workRepoDir, ["push", "origin", `HEAD:${sourceBranch}`]);
  return {
    id: "run_test123",
    status: "succeeded",
    input: { mutationMode: "parallel", targetBranch: "main" },
    output: {
      smithersRunId: "smithers_test",
      outputs: {
        baseline: {
          repoDir: workRepoDir,
          targetBranch: sourceBranch,
          lease: {
            mode: "parallel",
            sourceRepoDir: repo,
            workRepoDir,
            workBranch: sourceBranch,
            pushBranch: sourceBranch,
            targetBranch: "main"
          }
        },
        commit: { commit },
        push: { pushed: true, branch: sourceBranch }
      }
    }
  };
}

describe("run promotion", () => {
  it("detects successful isolated runs as promotable", () => {
    const { repo, worktrees } = initFixture();
    const run = isolatedRun({ repo, worktrees });

    const candidate = runPromotionCandidate(run, { env: { RUNYARD_REPO_WORKTREE_DIR: worktrees } });

    assert.equal(candidate.available, true);
    assert.equal(candidate.sourceBranch, "runyard/implement-change-gated/main/run_test123");
    assert.equal(candidate.targetBranch, "main");
  });

  it("detects live Smithers output with a serialized lease as promotable", () => {
    const { repo, worktrees } = initFixture();
    const run = isolatedRun({ repo, worktrees });
    const lease = run.output.outputs.baseline.lease;
    run.output.outputs.baseline = {
      start_head: git(repo, ["rev-parse", "HEAD"]),
      repo_dir: lease.workRepoDir,
      target_branch: lease.pushBranch,
      lease: JSON.stringify(lease)
    };

    const candidate = runPromotionCandidate(run, { env: { RUNYARD_REPO_WORKTREE_DIR: worktrees } });

    assert.equal(candidate.available, true);
    assert.equal(candidate.sourceRepoDir, repo);
    assert.equal(candidate.workRepoDir, lease.workRepoDir);
    assert.equal(candidate.sourceBranch, "runyard/implement-change-gated/main/run_test123");
  });

  it("rejects unsafe target and isolated branch metadata before promotion", () => {
    const { repo, worktrees } = initFixture();
    const badTarget = isolatedRun({ repo, worktrees });
    badTarget.input.targetBranch = "--upload-pack=/tmp/evil";
    badTarget.output.outputs.baseline.lease.targetBranch = "--upload-pack=/tmp/evil";

    const targetCandidate = runPromotionCandidate(badTarget, { env: { RUNYARD_REPO_WORKTREE_DIR: worktrees } });
    assert.equal(targetCandidate.available, false);
    assert.equal(targetCandidate.reason, "invalid target branch metadata");
    assert.throws(
      () => promoteRunToMain(badTarget, { env: { RUNYARD_REPO_WORKTREE_DIR: worktrees }, gates: false }),
      /invalid target branch metadata/
    );

    const sourceFixture = initFixture();
    const badSource = isolatedRun({ repo: sourceFixture.repo, worktrees: sourceFixture.worktrees });
    badSource.output.outputs.push.branch = "runyard/implement-change-gated/main/run_test123 bad";
    const sourceCandidate = runPromotionCandidate(badSource, { env: { RUNYARD_REPO_WORKTREE_DIR: sourceFixture.worktrees } });
    assert.equal(sourceCandidate.available, false);
    assert.equal(sourceCandidate.reason, "invalid isolated branch metadata");
  });

  it("merges the isolated branch, pushes main, and removes branch/worktree", () => {
    const { repo, origin, worktrees } = initFixture();
    const run = isolatedRun({ repo, worktrees });

    const promotion = promoteRunToMain(run, {
      env: { RUNYARD_REPO_WORKTREE_DIR: worktrees },
      gates: false
    });

    assert.equal(promotion.merged, true);
    assert.match(promotion.mergeCommit, /^[0-9a-f]{40}$/);
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(git(repo, ["show", "HEAD:feature.txt"]), "feature");
    assert.equal(git(origin, ["rev-parse", "main"]), promotion.mergeCommit);
    assert.equal(existsSync(run.output.outputs.baseline.lease.workRepoDir), false);
    assert.throws(() => git(repo, ["rev-parse", "--verify", run.output.outputs.push.branch]));
    assert.throws(() => git(origin, ["rev-parse", "--verify", run.output.outputs.push.branch]));
  });

  it("runs promotion gates without production secrets from the service env", () => {
    const { repo, origin, worktrees } = initFixture();
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"if (process.env.TELEGRAM_BOT_TOKEN) process.exit(7)\"",
        build: "node -e \"if (process.env.PROD_API_KEY) process.exit(8)\""
      }
    }, null, 2));
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "add gate scripts"]);
    git(repo, ["push", "origin", "main"]);
    const run = isolatedRun({ repo, worktrees });

    const promotion = promoteRunToMain(run, {
      env: { RUNYARD_REPO_WORKTREE_DIR: worktrees },
      gates: true,
      gitEnv: { ...process.env, TELEGRAM_BOT_TOKEN: "prod-token", PROD_API_KEY: "prod-key" }
    });

    assert.equal(promotion.merged, true);
    assert.equal(git(origin, ["rev-parse", "main"]), promotion.mergeCommit);
  });
});
