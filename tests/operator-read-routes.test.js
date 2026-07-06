import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createOperatorReadHandlers,
  dashboardPayload
} from "../src/operatorReadRoutes.js";
import { mockResponse as response } from "./response.js";

function deps(overrides = {}) {
  const runs = [
    { id: "run_recent", status: "running" },
    { id: "run_queued_2", status: "queued" }
  ];
  const queuedRuns = [
    { id: "run_queued_1", status: "queued" },
    { id: "run_queued_2", status: "queued" }
  ];
  return {
    dashboardStats: () => ({ queued: 2, running: 1 }),
    listApprovals: (status) => status === "pending" ? [{ id: "approval_1" }] : [],
    listRuns: (options) => options.status === "queued" ? queuedRuns : runs,
    runnerPoolStats: () => ({ total: 3, idle: 1 }),
    withApprovalLinks: (approval) => ({ ...approval, linked: true }),
    withRunLinks: (run, queueIndex) => ({
      ...run,
      queuePosition: queueIndex?.map.get(run.id) || null
    }),
    ...overrides
  };
}

describe("operator read route helpers", () => {
  it("builds the dashboard payload from shared read helpers", () => {
    const calls = [];
    const payload = dashboardPayload(deps({
      listRuns: (options) => {
        calls.push(options);
        return options.status === "queued"
          ? [{ id: "run_queued_1", status: "queued" }, { id: "run_queued_2", status: "queued" }]
          : [{ id: "run_recent", status: "running" }, { id: "run_queued_2", status: "queued" }];
      }
    }));

    assert.deepEqual(calls, [{ limit: 8 }, { status: "queued", limit: 500 }]);
    assert.deepEqual(payload.stats, { queued: 2, running: 1 });
    assert.deepEqual(payload.pool, { total: 3, idle: 1 });
    assert.deepEqual(payload.pendingApprovals, [{ id: "approval_1", linked: true }]);
    assert.equal(payload.recentRuns[0].queuePosition, null);
    assert.equal(payload.recentRuns[1].queuePosition, 2);
  });

  it("serves dashboard and repo-options through route handlers", () => {
    const handlers = createOperatorReadHandlers({
      ...deps(),
      env: {
        IMPROVE_REPO_MAP: JSON.stringify({ app: "/srv/app" })
      }
    });
    const dashboard = response();
    const repoOptions = response();

    handlers.dashboard({}, dashboard);
    handlers.repoOptions({}, repoOptions);

    assert.equal(dashboard.body.recentRuns.length, 2);
    assert.ok(repoOptions.body.options.some((option) => option.value === "app"));
    assert.equal(repoOptions.body.options.find((option) => option.value === "app").repoDir, undefined);
  });

  it("merges repo-options from runner config without exposing paths", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "runyard-operator-repo-config-"));
    const configFile = path.join(dir, "runner.config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        improve: {
          repoMap: { skillmarket: "/srv/skillmarket" },
          allowedRepoRoots: ["/srv/skillmarket"]
        },
        repoCatalog: [{ value: "skillmarket", label: "SkillMarket", selector: "repo" }]
      })
    );
    const handlers = createOperatorReadHandlers({
      ...deps(),
      env: { RUNYARD_RUNNER_CONFIG: configFile }
    });
    const repoOptions = response();

    handlers.repoOptions({}, repoOptions);

    const option = repoOptions.body.options.find((entry) => entry.value === "skillmarket");
    assert.equal(option.label, "SkillMarket");
    assert.equal(option.repoDir, undefined);
  });
});
