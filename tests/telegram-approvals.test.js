import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvalDecisionLabel,
  firstCsvValue,
  htmlEscape,
  isRunStartApproval,
  parseTelegramApprovalCallback,
  shouldNotifyTelegram,
  telegramApprovalButtonClearPayload,
  telegramApprovalMessagePayload,
  telegramApprovalTarget
} from "../src/telegramApprovals.js";

const approvalContext = () => ({
  workflow: { name: "Improve <App>", slug: "improve" },
  proposedChange: "Change <script>",
  proposedAction: "Queue & run",
  requestedBy: "mcp: operator",
  project: { display: "Runyard / repo" },
  targetBranch: "main",
  branch: "",
  deploy: true,
  run: { status: "queued" }
});

describe("telegram approval helpers", () => {
  it("resolves private approval targets before fallback chat targets", () => {
    assert.equal(firstCsvValue(" 123,456 "), "123");
    assert.deepEqual(telegramApprovalTarget({ approvalChatId: "111,222", telegramChatId: "333" }), {
      chatId: "111",
      private: true
    });
    assert.deepEqual(telegramApprovalTarget({ telegramChatId: "333", telegramThreadId: "12" }), {
      chatId: "333",
      private: false,
      threadId: 12
    });
    assert.equal(telegramApprovalTarget({}), null);
  });

  it("builds escaped approval sendMessage payloads", () => {
    const payload = telegramApprovalMessagePayload({
      target: { chatId: "111", private: true },
      approval: { id: "appr_abc", runId: "run_1" },
      approvalUrl: "https://hub.example/app#approvals/appr_abc",
      approvalContext,
      instanceName: "Run&Yard"
    });

    assert.equal(payload.chat_id, "111");
    assert.equal(payload.parse_mode, "HTML");
    assert.match(payload.text, /Run&amp;Yard approval requested/);
    assert.match(payload.text, /Improve &lt;App&gt; \(improve\)/);
    assert.match(payload.text, /Change &lt;script&gt;/);
    assert.deepEqual(payload.reply_markup.inline_keyboard[0][0], {
      text: "Open approval",
      web_app: { url: "https://hub.example/app#approvals/appr_abc" }
    });
  });

  it("escapes primitive HTML text", () => {
    assert.equal(htmlEscape(`<tag attr="x">&'`), "&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("applies run-start Telegram notification policy", () => {
    const approval = {
      runId: "run_1",
      title: "Approve run",
      payload: { capability: "deploy", input: { ok: true } }
    };
    assert.equal(isRunStartApproval(approval), true);
    assert.equal(shouldNotifyTelegram(approval, { getCapability: () => ({ approvalPolicy: {} }) }), true);
    assert.equal(
      shouldNotifyTelegram(approval, { getCapability: () => ({ approvalPolicy: { notifications: { telegram: false } } }) }),
      false
    );
    assert.equal(shouldNotifyTelegram({ payload: {} }, {}), true);
    assert.equal(shouldNotifyTelegram(null), false);
  });

  it("parses callback decisions and rejects malformed callback data", () => {
    assert.deepEqual(parseTelegramApprovalCallback("approval:approve:appr_0123456789abcdef0123"), {
      ok: true,
      approvalId: "appr_0123456789abcdef0123",
      decision: "approved"
    });
    assert.deepEqual(parseTelegramApprovalCallback("request-changes:appr_0123456789abcdef0123"), {
      ok: true,
      approvalId: "appr_0123456789abcdef0123",
      decision: "changes_requested"
    });
    assert.equal(parseTelegramApprovalCallback("").error, "missing callback data");
    assert.equal(parseTelegramApprovalCallback("approval:bad:appr_0123456789abcdef0123").error, "invalid approval decision");
    assert.equal(parseTelegramApprovalCallback("approval:approve:not-an-id").error, "invalid approval id");
  });

  it("builds button cleanup payloads and decision labels", () => {
    assert.deepEqual(telegramApprovalButtonClearPayload({ inline_message_id: "inline" }), {
      inline_message_id: "inline",
      reply_markup: { inline_keyboard: [] }
    });
    assert.deepEqual(telegramApprovalButtonClearPayload({ message: { chat: { id: 1 }, message_id: 2 } }), {
      chat_id: 1,
      message_id: 2,
      reply_markup: { inline_keyboard: [] }
    });
    assert.equal(telegramApprovalButtonClearPayload({}), null);
    assert.equal(approvalDecisionLabel("approved"), "Approved");
    assert.equal(approvalDecisionLabel("changes_requested"), "Changes requested");
    assert.equal(approvalDecisionLabel("rejected"), "Rejected");
  });
});
