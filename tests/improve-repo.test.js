import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveImproveRepo } from "../workflow-templates/workflows/improve-repo.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-improve-repo-"));

after(() => {
  rmSync(temp, { recursive: true, force: true });
});

function initRepo(name) {
  const repoDir = path.join(temp, name);
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  return realpathSync(repoDir);
}

function resolve(input, env, cwd) {
  return resolveImproveRepo(input, { env, cwd, gitBin: "git", gitEnv: process.env });
}

describe("improve repo resolution", () => {
  it("preserves the default repo behavior when no repo input is provided", () => {
    const defaultRepo = initRepo("default");

    assert.equal(resolve({}, {}, defaultRepo), defaultRepo);
  });

  it("prefers an explicit RunYard repo env over the Smithers workspace cwd", () => {
    const runyardRepo = initRepo("runyard-default");
    const workspace = path.join(temp, "smithers-workspace");
    mkdirSync(workspace, { recursive: true });

    assert.equal(resolve({}, { RUNYARD_REPO_DIR: runyardRepo, SMITHERS_WORKSPACE: workspace }, workspace), runyardRepo);
  });

  it("uses an absolute allowlisted repoDir for another runner-local repo", () => {
    const defaultRepo = initRepo("default-for-repodir");
    const reposRoot = path.join(temp, "repos");
    const otherRepo = initRepo(path.join("repos", "other"));

    assert.equal(
      resolve(
        { repoDir: otherRepo },
        { IMPROVE_ALLOWED_REPO_ROOTS: reposRoot },
        defaultRepo
      ),
      otherRepo
    );
  });

  it("rejects repoDir paths outside the allowed roots", () => {
    const defaultRepo = initRepo("default-for-unsafe");
    const outsideRepo = initRepo("outside");

    assert.throws(
      () => resolve({ repoDir: outsideRepo }, {}, defaultRepo),
      /outside allowed roots/
    );
  });

  it("rejects relative repoDir values", () => {
    const defaultRepo = initRepo("default-for-relative");

    assert.throws(
      () => resolve({ repoDir: "relative/repo" }, {}, defaultRepo),
      /repoDir must be an absolute runner-local path/
    );
  });

  it("resolves friendly repo and project keys from runner env JSON maps", () => {
    const defaultRepo = initRepo("default-for-map");
    const reposRoot = path.join(temp, "mapped-repos");
    const repoByRepoKey = initRepo(path.join("mapped-repos", "repo-key"));
    const repoByProjectKey = initRepo(path.join("mapped-repos", "project-key"));
    const env = {
      IMPROVE_ALLOWED_REPO_ROOTS: JSON.stringify([reposRoot]),
      IMPROVE_REPO_MAP: JSON.stringify({ docs: repoByRepoKey }),
      IMPROVE_PROJECT_MAP: JSON.stringify({ app: repoByProjectKey })
    };

    assert.equal(resolve({ repo: "docs" }, env, defaultRepo), repoByRepoKey);
    assert.equal(resolve({ project: "app" }, env, defaultRepo), repoByProjectKey);
  });

  it("treats the UI default smithers-hub key as the default repo", () => {
    const defaultRepo = initRepo("default-for-smithers-hub-key");
    const otherCwd = path.join(temp, "not-the-default-cwd");
    mkdirSync(otherCwd, { recursive: true });

    assert.equal(resolve({ repo: "smithers-hub" }, { IMPROVE_REPO_DIR: defaultRepo }, otherCwd), defaultRepo);
    assert.equal(resolve({ project: "smithers-hub" }, { IMPROVE_REPO_DIR: defaultRepo }, otherCwd), defaultRepo);
  });

  it("prefers an explicit smithers-hub map entry over the workspace default", () => {
    const workspaceDefault = initRepo("workspace-default-for-smithers-hub-map");
    const mappedHub = initRepo("mapped-smithers-hub");
    const env = {
      IMPROVE_REPO_MAP: JSON.stringify({ "smithers-hub": mappedHub }),
      IMPROVE_ALLOWED_REPO_ROOTS: mappedHub
    };

    assert.equal(resolve({ repo: "smithers-hub" }, env, workspaceDefault), mappedHub);
  });

  it("rejects unknown friendly repo selectors clearly", () => {
    const defaultRepo = initRepo("default-for-missing-map");

    assert.throws(
      () => resolve({ repo: "missing" }, { IMPROVE_REPO_MAP: "{}" }, defaultRepo),
      /repo selector "missing" is not configured/
    );
  });
});
