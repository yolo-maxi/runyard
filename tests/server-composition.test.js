import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServerComposition } from "../src/serverComposition.js";

function dbStub() {
  const noop = () => [];
  return new Proxy({ DEFAULT_HIDDEN_RUN_SLUGS: [] }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return noop;
    }
  });
}

function envStub() {
  return {
    artifactDir: "/tmp/runyard-artifacts",
    baseUrl: "http://127.0.0.1:43117",
    root: process.cwd(),
    runDeadlineMs: 1000,
    runTimelineEnabled: true,
    telegramWebhookSecret: "secret"
  };
}

describe("server composition", () => {
  it("builds route and runtime surfaces from injected dependencies", () => {
    const composition = createServerComposition({
      db: dbStub(),
      env: envStub(),
      getUpdateChecker: () => ({ check: async () => ({ ok: true }) }),
      getVersionInfo: () => ({ version: "test" }),
      processEnv: {},
      startedAt: 123
    });

    assert.equal(typeof composition.dispatchHubRepair, "function");
    assert.equal(typeof composition.fireDueSchedules, "function");
    assert.equal(typeof composition.notifyTelegram, "function");
    assert.equal(typeof composition.telegramApprovalTarget, "function");
    assert.equal(typeof composition.reapStuckRunsWithRetrospectives, "function");
    assert.equal(typeof composition.pruneDeadRunners, "function");
    assert.equal(typeof composition.reconcileFailedRecoverable, "function");
    assert.equal(typeof composition.reconcileRunnerActiveRuns, "function");

    assert.deepEqual(Object.keys(composition.routes).sort(), [
      "adminReadHandlers",
      "approvalHandlers",
      "artifactHandlers",
      "authHandlers",
      "capabilityHandlers",
      "catalogHandlers",
      "operatorReadHandlers",
      "publicHandlers",
      "requireAuth",
      "requireRunOwnerOrAdmin",
      "requireScopes",
      "runLifecycleHandlers",
      "runReadHandlers",
      "runRerunHandlers",
      "scheduleHandlers",
      "secretHandlers",
      "supportChatHandlers",
      "tokenHandlers",
      "updateHandlers",
      "workflowEndpointHandlers"
    ]);
  });
});
