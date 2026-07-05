import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTelegramApprovalNotifier } from "../src/telegramApprovalNotifier.js";

function notifier(overrides = {}) {
  const sent = [];
  const answered = [];
  const cleared = [];
  const edited = [];
  const stored = [];
  const instance = createTelegramApprovalNotifier({
    approvalContext: () => ({ workflow: { name: "Demo", slug: "demo" } }),
    env: {
      baseUrl: "https://hub.example/base",
      instanceName: "Runyard",
      telegramApprovalChatId: "111,222",
      telegramBotToken: "bot-token",
      telegramChatId: "-100",
      telegramThreadId: "12",
      ...overrides.env
    },
    getCapability: overrides.getCapability || (() => ({ approvalPolicy: {} })),
    getRun: overrides.getRun || (() => null),
    setApprovalTelegramMessage: async (approvalId, message) => {
      stored.push({ approvalId, message });
    },
    sendApprovalNotification: async (payload) => {
      sent.push(payload);
      return overrides.sendResult ?? true;
    },
    sendCallbackAnswer: async (payload) => {
      answered.push(payload);
      return true;
    },
    clearApprovalMarkup: async (payload) => {
      cleared.push(payload);
      return true;
    },
    editApprovalMessage: async (payload) => {
      edited.push(payload);
      return true;
    }
  });
  return { answered, cleared, edited, instance, sent, stored };
}

describe("telegram approval notifier", () => {
  it("prefers private approval chat targets over fallback chat targets", () => {
    assert.deepEqual(notifier().instance.telegramApprovalTarget(), { chatId: "111", private: true });
    assert.deepEqual(notifier({ env: { telegramApprovalChatId: "" } }).instance.telegramApprovalTarget(), {
      chatId: "-100",
      private: false,
      threadId: 12
    });
  });

  it("sends approval notifications with absolute approval links", async () => {
    const { instance, sent, stored } = notifier({
      sendResult: { message_id: 44, chat: { id: "111" } }
    });

    const ok = await instance.notifyTelegram({
      id: "appr_0123456789abcdef0123",
      payload: { kind: "approval_checkpoint" }
    });

    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].botToken, "bot-token");
    assert.deepEqual(sent[0].target, { chatId: "111", private: true });
    assert.equal(sent[0].approvalUrl, "https://hub.example/app#approvals/appr_0123456789abcdef0123");
    assert.equal(sent[0].instanceName, "Runyard");
    assert.deepEqual(stored[0], {
      approvalId: "appr_0123456789abcdef0123",
      message: { chatId: "111", messageId: 44 }
    });
  });

  it("skips notifications when bot config or policy says not to notify", async () => {
    const noBot = notifier({ env: { telegramBotToken: "" } });
    assert.equal(await noBot.instance.notifyTelegram({ id: "appr_0123456789abcdef0123" }), false);
    assert.equal(noBot.sent.length, 0);

    const disabledPolicy = notifier({
      getCapability: () => ({ approvalPolicy: { notifications: { telegram: false } } }),
      getRun: () => ({ capabilitySlug: "demo" })
    });
    const ok = await disabledPolicy.instance.notifyTelegram({
      id: "appr_0123456789abcdef0123",
      runId: "run_1",
      title: "Approve demo",
      payload: { capability: "demo", input: {} }
    });
    assert.equal(ok, false);
    assert.equal(disabledPolicy.sent.length, 0);
  });

  it("delegates Telegram callback acknowledgements and button cleanup", async () => {
    const { answered, cleared, instance } = notifier();

    assert.equal(await instance.answerTelegramCallbackQuery("cb_1", "Done"), true);
    assert.equal(await instance.clearTelegramApprovalButtons({ message: { chat: { id: "1" }, message_id: 2 } }), true);

    assert.deepEqual(answered[0], { botToken: "bot-token", callbackQueryId: "cb_1", text: "Done" });
    assert.deepEqual(cleared[0], {
      botToken: "bot-token",
      callback: { message: { chat: { id: "1" }, message_id: 2 } }
    });
  });

  it("updates stored Telegram approval messages with stale buttons cleared", async () => {
    const { edited, instance } = notifier();
    assert.equal(
      await instance.updateStoredTelegramApprovalMessage({
        id: "appr_0123456789abcdef0123",
        status: "resolved",
        resolution: "approved",
        resolvedBy: "system:approval-timer",
        resolvedAt: "2026-07-05T00:00:00.000Z",
        telegramMessage: { chatId: "111", messageId: 44 }
      }),
      true
    );
    assert.equal(edited[0].callback.message.chat.id, "111");
    assert.equal(edited[0].callback.message.message_id, 44);
  });
});
