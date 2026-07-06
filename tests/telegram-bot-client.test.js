import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  answerTelegramCallbackQuery,
  callTelegramBot,
  clearTelegramApprovalButtons,
  editTelegramApprovalMessage,
  sendTelegramApprovalVisual,
  sendTelegramApprovalNotification
} from "../src/telegramBotClient.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

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

  it("sends an optional visual approval header through sendPhoto", async () => {
    const calls = [];
    const ok = await sendTelegramApprovalVisual({
      botToken: "token",
      target: { chatId: "42", threadId: 7 },
      approval: { id: "appr_123", title: "Deploy?", payload: {} },
      approvalContext: () => ({
        approval: { kind: "side_effect", kindLabel: "Side effect" },
        workflow: { name: "Deploy production", slug: "deploy-production" },
        project: { repo: "/home/xiko/runyard" }
      }),
      renderApprovalVisual: async (summary) => {
        assert.deepEqual(summary, {
          workflow: "Deploy production",
          repo: "runyard",
          runTitle: "",
          kind: "External action"
        });
        return tinyPng;
      },
      fetchImpl: async (url, options) => {
        calls.push({
          url,
          options,
          photoBytes: Buffer.from(await options.body.get("photo").arrayBuffer())
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 12, chat: { id: "42" }, photo: [{ file_id: "p" }] } })
        };
      }
    });

    assert.deepEqual(ok, { message_id: 12, chat: { id: "42" }, photo: [{ file_id: "p" }] });
    assert.equal(calls[0].url.endsWith("/sendPhoto"), true);
    assert.equal(calls[0].options.body.get("chat_id"), "42");
    assert.equal(calls[0].options.body.get("message_thread_id"), "7");
    assert.equal(calls[0].options.body.get("photo").type, "image/png");
    assert.match(calls[0].photoBytes.toString("utf8"), /RunYard approval visual/);
    assert.match(calls[0].photoBytes.toString("utf8"), /Workflow: Deploy production/);
    assert.match(calls[0].photoBytes.toString("utf8"), /Repo\/project: runyard/);
    assert.match(calls[0].options.body.get("caption"), /<b>⏳ Deploy\?<\/b>/);
    assert.match(calls[0].options.body.get("reply_markup"), /approval:approve:appr_123/);
  });

  it("edits photo approval captions when a visual message resolves", async () => {
    const calls = [];
    await editTelegramApprovalMessage({
      botToken: "token",
      callback: { message: { chat: { id: "42" }, message_id: 9 }, messageKind: "photo" },
      approval: {
        id: "appr_123",
        status: "resolved",
        resolution: "rejected",
        resolvedVia: "fallback_timer",
        resolvedAt: "2026-07-05T00:00:00.000Z",
        title: "Deploy?"
      },
      approvalContext: () => ({ approval: { resolutionLabel: "Rejected" }, requestedBy: "ci" }),
      instanceName: "Runyard",
      fetchImpl: okFetch(calls)
    });

    assert.equal(calls[0].url.endsWith("/editMessageCaption"), true);
    assert.equal(calls[0].body.chat_id, "42");
    assert.equal(calls[0].body.message_id, 9);
    assert.match(calls[0].body.caption, /<b>🚫 Deploy\?<\/b>/);
    assert.equal(calls[0].body.text, undefined);
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
