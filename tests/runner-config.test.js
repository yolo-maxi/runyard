import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadRunnerConfigEnv, runnerConfigEnv, runnerConfigPath } from "../src/runnerConfig.js";

describe("runner config", () => {
  it("uses runner.config.json in the working directory by default", () => {
    assert.equal(runnerConfigPath({ env: {}, cwd: "/srv/runyard" }), "/srv/runyard/runner.config.json");
  });

  it("allows an explicit config path override", () => {
    assert.equal(
      runnerConfigPath({ env: { RUNYARD_RUNNER_CONFIG: "/etc/runyard/runner.json" }, cwd: "/srv/runyard" }),
      "/etc/runyard/runner.json"
    );
  });

  it("normalizes repo policy config into env keys consumed by workflows", () => {
    const env = runnerConfigEnv({
      improve: {
        defaultRepo: "/srv/runyard",
        allowedRepoRoots: ["/srv/runyard", "/srv/skillmarket"],
        repoMap: { runyard: "/srv/runyard", skillmarket: "/srv/skillmarket" },
        projectMap: { docs: "/srv/docs" }
      },
      repoCatalog: [
        { value: "runyard", label: "RunYard", selector: "repo" },
        { value: "skillmarket", label: "SkillMarket", selector: "repo", description: "Workflow marketplace" }
      ]
    });

    assert.equal(env.IMPROVE_REPO_DIR, "/srv/runyard");
    assert.deepEqual(JSON.parse(env.IMPROVE_ALLOWED_REPO_ROOTS), ["/srv/runyard", "/srv/skillmarket"]);
    assert.deepEqual(JSON.parse(env.IMPROVE_REPO_MAP), {
      runyard: "/srv/runyard",
      skillmarket: "/srv/skillmarket"
    });
    assert.deepEqual(JSON.parse(env.IMPROVE_PROJECT_MAP), { docs: "/srv/docs" });
    assert.deepEqual(JSON.parse(env.SMITHERS_REPO_CATALOG), [
      { value: "runyard", label: "RunYard", selector: "repo" },
      {
        value: "skillmarket",
        label: "SkillMarket",
        selector: "repo",
        description: "Workflow marketplace"
      }
    ]);
  });

  it("loads config from disk without throwing on missing or malformed files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "runyard-runner-cfg-"));
    const configFile = path.join(dir, "runner.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        improve: { allowedRepoRoots: ["/srv/runyard"], repoMap: { runyard: "/srv/runyard" } }
      })
    );

    assert.deepEqual(JSON.parse(loadRunnerConfigEnv({ env: {}, cwd: dir }).IMPROVE_REPO_MAP), {
      runyard: "/srv/runyard"
    });
    assert.deepEqual(loadRunnerConfigEnv({ env: {}, cwd: path.join(dir, "missing") }), {});

    const badDir = mkdtempSync(path.join(os.tmpdir(), "runyard-runner-cfg-bad-"));
    writeFileSync(path.join(badDir, "runner.config.json"), "{bad");
    assert.deepEqual(loadRunnerConfigEnv({ env: {}, cwd: badDir }), {});
  });
});
