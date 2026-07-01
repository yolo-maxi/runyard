import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answerTelegramCallbackQuery,
  callTelegramBot,
  clearTelegramApprovalButtons,
  sendTelegramApprovalNotification
} from "../src/telegramBotClient.js";

function okFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  };
}

describe("telegram bot client", () => {
  it("posts bot methods and reports success", async () => {
    const calls = [];
    const ok = await callTelegramBot({
      botToken: "token",
      method: "sendMessage",
      payload: { chat_id: "1", text: "hello" },
      fetchImpl: okFetch(calls)
    });

    assert.equal(ok, true);
    assert.equal(calls[0].url, "https://api.telegram.org/bottoken/sendMessage");
    assert.deepEqual(calls[0].body, { chat_id: "1", text: "hello" });
  });

  it("sends approval notifications through sendMessage", async () => {
    const calls = [];
    const ok = await sendTelegramApprovalNotification({
      botToken: "token",
      target: { chatId: "42", threadId: 7 },
      approval: { id: "appr_123", title: "Deploy?", description: "Ship it", requestedBy: "ci", payload: {} },
      approvalUrl: "https://hub.example/app#approvals/appr_123",
      approvalContext: () => ({ title: "Deploy?", description: "Ship it", run: null }),
      instanceName: "Runyard",
      fetchImpl: okFetch(calls)
    });

    assert.equal(ok, true);
    assert.equal(calls[0].url.endsWith("/sendMessage"), true);
    assert.equal(calls[0].body.chat_id, "42");
    assert.equal(calls[0].body.message_thread_id, 7);
    assert.ok(calls[0].body.reply_markup.inline_keyboard.length > 0);
  });

  it("answers callback queries with truncated text", async () => {
    const calls = [];
    await answerTelegramCallbackQuery({
      botToken: "token",
      callbackQueryId: "cb_1",
      text: "x".repeat(300),
      fetchImpl: okFetch(calls)
    });

    assert.equal(calls[0].url.endsWith("/answerCallbackQuery"), true);
    assert.equal(calls[0].body.callback_query_id, "cb_1");
    assert.equal(calls[0].body.text.length, 180);
  });

  it("clears approval buttons for normal message callbacks", async () => {
    const calls = [];
    await clearTelegramApprovalButtons({
      botToken: "token",
      callback: { message: { chat: { id: "42" }, message_id: 9 } },
      fetchImpl: okFetch(calls)
    });

    assert.equal(calls[0].url.endsWith("/editMessageReplyMarkup"), true);
    assert.deepEqual(calls[0].body, {
      chat_id: "42",
      message_id: 9,
      reply_markup: { inline_keyboard: [] }
    });
  });
});
