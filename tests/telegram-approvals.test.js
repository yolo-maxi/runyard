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
  telegramApprovalIfIgnoredLine,
  telegramApprovalKindLead,
  telegramApprovalMessageEditPayload,
  telegramApprovalMessagePayload,
  telegramApprovalStoredMessage,
  telegramApprovalStoredMessageCallback,
  telegramApprovalTarget,
  telegramApprovalText,
  telegramTime
} from "../src/telegramApprovals.js";

const approvalContext = () => ({
  approval: { kind: "custom" },
  ask: { action: "Queue & run", reason: "Runs a coding agent on the repo.", audience: "operators" },
  workflow: { name: "Improve <App>", slug: "improve" },
  proposedChange: "Change <script>",
  proposedAction: "Queue & run",
  requestedBy: "mcp: operator",
  project: { display: "Runyard / repo" },
  targetBranch: "main",
  branch: "",
  deploy: true,
  run: { status: "queued", statusLabel: "Queued" },
  whatHappensIfIgnored: "Nothing happens by itself: this card waits until someone decides."
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

  it("builds escaped approval sendMessage payloads answering what/why/if-ignored", () => {
    const payload = telegramApprovalMessagePayload({
      target: { chatId: "111", private: true },
      approval: { id: "appr_abc", runId: "run_1", status: "pending", title: "Approve Improve" },
      approvalUrl: "https://hub.example/app#approvals/appr_abc",
      approvalContext,
      instanceName: "Run&Yard"
    });

    assert.equal(payload.chat_id, "111");
    assert.equal(payload.parse_mode, "HTML");
    assert.match(payload.text, /<b>⏳ Approve Improve<\/b>/);
    assert.match(payload.text, /<i>Context<\/i>: mcp: operator/);
    assert.match(payload.text, /<b>Approve<\/b>: Queue &amp; run/);
    assert.match(payload.text, /Queue &amp; run/);
    assert.match(payload.text, /<b>Why<\/b>: Runs a coding agent on the repo\./);
    assert.match(payload.text, /Runs a coding agent on the repo\./);
    assert.match(payload.text, /<b>Details<\/b>: Change &lt;script&gt;/);
    assert.doesNotMatch(payload.text, /Improve &lt;App&gt; \(improve\)/);
    assert.doesNotMatch(payload.text, /<b>Run:<\/b>/);
    assert.doesNotMatch(payload.text, /<b>Card:<\/b>/);
    // The vestigial empty header is gone.
    assert.doesNotMatch(payload.text, /Thing being approved/);
    assert.deepEqual(payload.reply_markup.inline_keyboard[0][0], {
      text: "Open approval",
      web_app: { url: "https://hub.example/app#approvals/appr_abc" }
    });
  });

  it("leads with the card's kind and states the deadline + fallback on timed cards", () => {
    assert.equal(telegramApprovalKindLead("workflow_gate"), "Gate needs sign-off");
    assert.equal(telegramApprovalKindLead("escalation"), "Recovery decision needed");
    assert.equal(telegramApprovalKindLead("side_effect"), "Side effect needs sign-off");

    const timedContext = () => ({
      ...approvalContext(),
      approval: { kind: "workflow_gate", fallbackDecisionLabel: "Approved" },
      whatHappensIfIgnored: ""
    });
    const text = telegramApprovalText(
      {
        id: "appr_abc",
        status: "pending",
        kind: "workflow_gate",
        title: "Approve app skin direction",
        timeoutAt: "2026-07-04T18:00:00.000Z",
        fallback: { decision: "approved" }
      },
      { approvalContext: timedContext, instanceName: "Runyard" }
    );
    assert.doesNotMatch(text, /Gate needs sign-off/);
    assert.match(text, /✅ Auto-approves <tg-time unix="1783188000" format="r">soon<\/tg-time>/);
  });

  it("uses relative Telegram time for resolved approval timestamps", () => {
    const resolvedContext = () => ({
      ...approvalContext(),
      approval: { kind: "custom", resolutionLabel: "Rejected", resolvedViaLabel: "decided by the timer (autopilot)" }
    });
    const text = telegramApprovalText(
      {
        id: "appr_abc",
        status: "resolved",
        resolution: "rejected",
        resolvedVia: "fallback_timer",
        resolvedBy: "system:approval-timer",
        resolvedAt: "2026-07-04T18:00:00.000Z",
        title: "Expired approval"
      },
      { approvalContext: resolvedContext, instanceName: "Runyard" }
    );
    assert.match(text, /🚫 Expired <tg-time unix="1783188000" format="r">now<\/tg-time>/);
    assert.match(text, /<b>Result<\/b>: rejected by timer/);
    assert.doesNotMatch(text, /2026-07-04T18:00:00\.000Z/);
  });

  it("states that blocking cards wait and never fail the run", () => {
    const blockingContext = () => ({ ...approvalContext(), whatHappensIfIgnored: "" });
    const line = telegramApprovalIfIgnoredLine({ id: "appr_abc", status: "pending" }, blockingContext());
    assert.match(line, /Waits for a human/);
    assert.match(line, /never fails/);
  });

  it("builds stored message references for later expiry edits", () => {
    assert.deepEqual(
      telegramApprovalStoredMessage({
        target: { chatId: "42" },
        sendResult: { message_id: 9, chat: { id: "42" }, photo: [{ file_id: "photo" }] }
      }),
      { chatId: "42", messageId: 9, kind: "photo" }
    );
    assert.deepEqual(telegramApprovalStoredMessageCallback({ chatId: "42", messageId: 9, kind: "photo" }), {
      message: { chat: { id: "42" }, message_id: 9 },
      messageKind: "photo"
    });
    assert.equal(telegramApprovalStoredMessage({ target: { chatId: "42" }, sendResult: true }), null);
    assert.equal(telegramApprovalStoredMessageCallback({}), null);
  });

  it("edits a decided message to name the outcome instead of asking for buttons", () => {
    const resolvedApproval = {
      id: "appr_abc",
      status: "resolved",
      resolution: "approved",
      resolvedBy: "telegram:fran",
      resolvedAt: "2026-07-04T17:42:00.000Z",
      title: "Approve Improve"
    };
    const resolvedContext = () => ({
      ...approvalContext(),
      approval: { kind: "custom", resolutionLabel: "Approved", resolvedViaLabel: "decided by a human" }
    });
    const payload = telegramApprovalMessageEditPayload({
      callback: { message: { chat: { id: 1 }, message_id: 2 } },
      approval: resolvedApproval,
      approvalContext: resolvedContext,
      instanceName: "Runyard"
    });
    assert.equal(payload.chat_id, 1);
    assert.equal(payload.message_id, 2);
    assert.deepEqual(payload.reply_markup, { inline_keyboard: [] });
    assert.match(payload.text, /✅ Approved by telegram:fran <tg-time unix="1783186920" format="r">now<\/tg-time>/);
    assert.doesNotMatch(payload.text, /Use the buttons below to decide\./);
    // No editable message → no payload (caller falls back to clearing buttons).
    assert.equal(
      telegramApprovalMessageEditPayload({ callback: {}, approval: resolvedApproval, approvalContext: resolvedContext }),
      null
    );
  });

  it("escapes primitive HTML text", () => {
    assert.equal(htmlEscape(`<tag attr="x">&'`), "&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;");
    assert.equal(
      telegramTime("2026-07-04T18:00:00.000Z", { format: "not-valid", fallback: "<soon>" }),
      '<tg-time unix="1783188000" format="r">&lt;soon&gt;</tg-time>'
    );
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
