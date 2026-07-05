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
      "hookProfileHandlers",
      "operatorReadHandlers",
      "publicHandlers",
      "requireAuth",
      "requireRunOwnerOrAdmin",
      "requireScopes",
      "runLifecycleHandlers",
      "runPromotionHandlers",
      "runReadHandlers",
      "runRerunHandlers",
      "scheduleHandlers",
      "secretHandlers",
      "supportChatHandlers",
      "tokenHandlers",
      "updateHandlers",
      "workflowBundleHandlers",
      "workflowEndpointHandlers"
    ]);
  });

  it("updates stored Telegram approval messages after timed approval sweeps", async () => {
    const calls = [];
    const previousFetch = global.fetch;
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };
    try {
      const approval = {
        id: "appr_0123456789abcdef0123",
        status: "resolved",
        resolution: "approved",
        resolvedVia: "fallback_timer",
        resolvedBy: "system:approval-timer",
        resolvedAt: "2026-07-05T00:00:00.000Z",
        title: "Timed approval",
        payload: {},
        telegramMessage: { chatId: "111", messageId: 44 }
      };
      const composition = createServerComposition({
        db: new Proxy(
          {
            DEFAULT_HIDDEN_RUN_SLUGS: [],
            getApproval: () => approval,
            sweepTimedApprovals: () => [{ id: approval.id, action: "fallback_applied", decision: "approved" }]
          },
          {
            get(target, prop) {
              if (prop in target) return target[prop];
              return () => [];
            }
          }
        ),
        env: { ...envStub(), telegramBotToken: "bot-token", instanceName: "Runyard" },
        getUpdateChecker: () => ({ check: async () => ({ ok: true }) }),
        getVersionInfo: () => ({ version: "test" }),
        processEnv: {},
        startedAt: 123
      });

      const swept = composition.sweepTimedApprovals();
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(swept, [{ id: approval.id, action: "fallback_applied", decision: "approved" }]);
      const edit = calls.find((call) => call.url.endsWith("/editMessageText"));
      assert.ok(edit);
      assert.equal(edit.body.chat_id, "111");
      assert.equal(edit.body.message_id, 44);
      assert.deepEqual(edit.body.reply_markup, { inline_keyboard: [] });
      assert.match(edit.body.text, /Approved/);
    } finally {
      global.fetch = previousFetch;
    }
  });
});
