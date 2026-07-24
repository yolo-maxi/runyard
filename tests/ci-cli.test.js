import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderCiPipeline, renderCiRepoList } from "../src/cliPresentation.js";

describe("ci CLI presentation", () => {
  it("renders an empty repo list with actionable next steps", () => {
    const empty = renderCiRepoList({ repos: [], installations: [] });
    assert.match(empty[0], /No CI-connected repositories/);
    assert.match(empty[1], /Install the GitHub App/);
    const withInstall = renderCiRepoList({ repos: [], installations: [{ installationId: "42" }] });
    assert.match(withInstall[1], /runyard repo sync/);
  });

  it("renders repo rows with enablement and trust", () => {
    const lines = renderCiRepoList({
      repos: [
        {
          id: "repo_1",
          fullName: "o/r",
          enabled: true,
          defaultBranch: "main",
          trustPolicy: { level: "trusted", allowNative: true }
        }
      ]
    });
    assert.match(lines[0], /o\/r\tenabled\ttrusted\+native\tdefault: main\tid: repo_1/);
  });

  it("renders a pipeline with provenance, job states, and check state", () => {
    const lines = renderCiPipeline({
      pipeline: {
        id: "cipipe_1",
        run: { id: "run_p", status: "running", deepLink: "/app#runs/run_p" },
        trigger: { event: "pull_request", prNumber: 7, ref: "feature/x", headSha: "a".repeat(40) },
        configSource: { path: ".runyard/ci.yml", sha: "b".repeat(40) },
        tested: { strategy: "merge" },
        jobs: [
          { jobName: "build", phase: "dispatched", run: { id: "run_b", status: "succeeded" }, checkState: "completed:success" },
          { jobName: "deploy", phase: "skipped", phaseReason: "dependency build failed" }
        ]
      }
    });
    assert.match(lines[0], /Pipeline cipipe_1 — running/);
    assert.match(lines[1], /pull_request PR #7/);
    assert.match(lines[2], /tested: merge/);
    assert.match(lines[3], /build\tsucceeded.*run: run_b.*check: completed:success/);
    assert.match(lines[4], /deploy\tskipped \(dependency build failed\)/);
    assert.match(lines[5], /\/app#runs\/run_p/);
  });
});
