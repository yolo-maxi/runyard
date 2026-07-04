import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvalResolutionIssue,
  createApprovalHandlers,
  telegramApprovalActor,
  telegramApprovalComment
} from "../src/approvalHttpRoutes.js";
import { mockResponse as response } from "./response.js";

const APPROVAL_ID = "appr_0123456789abcdefabcd";

function req({ body = {}, headers = {}, params = {}, query = {}, tokenName = "operator" } = {}) {
  return {
    body,
    headers,
    params,
    query,
    token: { id: "tok_1", name: tokenName }
  };
}

function harness(overrides = {}) {
  const approvals = new Map([
    [APPROVAL_ID, {
      id: APPROVAL_ID,
      status: "pending",
      runId: "run_1",
      title: "Approve",
      payload: { childRunId: "run_child", nodeId: "node_1" }
    }],
    ["appr_11111111111111111111", {
      id: "appr_11111111111111111111",
      status: "approved",
      runId: "run_done",
      title: "Done",
      payload: {}
    }]
  ]);
  for (const approval of overrides.approvals || []) approvals.set(approval.id, approval);

  const callbackAnswers = [];
  const clearedCallbacks = [];
  const created = [];
  const deliveries = [];
  const notifications = [];
  const resolved = [];

  const handlers = createApprovalHandlers({
    answerTelegramCallbackQuery: async (callbackQueryId, text) => {
      callbackAnswers.push({ callbackQueryId, text });
    },
    clearTelegramApprovalButtons: async (callback) => {
      clearedCallbacks.push(callback.id);
    },
    createApproval: (input) => {
      const approval = { id: "appr_created0000000000", status: "pending", ...input };
      created.push(input);
      approvals.set(approval.id, approval);
      return approval;
    },
    dispatchRunResponseEndpointDelivery: (runId) => deliveries.push(runId),
    getApproval: (id) => approvals.get(id) || null,
    getRun: (id) => (id === "run_1" ? { id, status: "waiting_approval" } : null),
    listApprovals: (status = "") => Array.from(approvals.values()).filter((approval) => !status || approval.status === status),
    logger: { error() {} },
    notifyTelegram: async (approval) => notifications.push(approval.id),
    resolveApproval: (id, decision, actor, comment) => {
      const approval = approvals.get(id);
      const next = { ...approval, status: decision, resolvedBy: actor, comment };
      approvals.set(id, next);
      resolved.push({ id, decision, actor, comment });
      return next;
    },
    telegramApprovalTarget: () => overrides.telegramTarget || { chatId: "123", private: true },
    telegramWebhookSecret: () => overrides.telegramWebhookSecret ?? "secret",
    timingSafeEqualStr: (a, b) => a === b,
    withApprovalLinks: (approval) => ({ ...approval, deepLink: `/app#approvals/${approval.id}` })
  });

  return { callbackAnswers, clearedCallbacks, created, deliveries, handlers, notifications, resolved };
}

function telegramReq({ data = `approval:reject:${APPROVAL_ID}`, chatId = "123", secret = "secret", from = { username: "alice" } } = {}) {
  return req({
    headers: { "x-telegram-bot-api-secret-token": secret },
    body: {
      callback_query: {
        id: "cb_1",
        data,
        from,
        message: { chat: { id: chatId }, message_id: 7 }
      }
    }
  });
}

describe("approval HTTP route helpers", () => {
  it("formats Telegram approval actors and comments", () => {
    assert.equal(telegramApprovalActor({ from: { username: "alice" } }), "telegram:alice");
    assert.equal(telegramApprovalActor({ from: { id: 42 } }), "telegram:42");
    assert.equal(telegramApprovalActor({}), "telegram:user");
    assert.equal(telegramApprovalComment("approved"), "Approved from Telegram");
    assert.equal(telegramApprovalComment("changes_requested"), "Changes requested from Telegram");
  });

  it("builds consistent approval resolution errors for web and Telegram transports", () => {
    assert.deepEqual(approvalResolutionIssue(null), {
      status: 404,
      body: { error: "approval not found" }
    });
    assert.deepEqual(approvalResolutionIssue(null, { includeOk: true }), {
      status: 404,
      body: { ok: false, error: "approval not found" }
    });
    assert.deepEqual(approvalResolutionIssue(
      { id: "appr_done", status: "approved" },
      { includeOk: true, withApprovalLinks: (approval) => ({ ...approval, deepLink: `/app#approvals/${approval.id}` }) }
    ), {
      status: 409,
      body: {
        ok: false,
        error: "approval is not pending",
        approval: { id: "appr_done", status: "approved", deepLink: "/app#approvals/appr_done" }
      }
    });
    assert.equal(approvalResolutionIssue({ id: APPROVAL_ID, status: "pending" }), null);
  });

  it("lists, fetches, and creates approval cards", async () => {
    const { created, handlers, notifications } = harness();

    const listRes = response();
    handlers.listApprovals(req({ query: { status: "pending" } }), listRes);
    assert.equal(listRes.body.approvals.length, 1);
    assert.equal(listRes.body.approvals[0].deepLink, `/app#approvals/${APPROVAL_ID}`);

    const getRes = response();
    handlers.getApproval(req({ params: { id: APPROVAL_ID } }), getRes);
    assert.equal(getRes.body.approval.id, APPROVAL_ID);

    const createRes = response();
    await handlers.createApproval(req({
      body: {
        runId: "run_1",
        title: "Ship it",
        requestedBy: "workflow",
        payload: { childRunId: "new_child", nodeId: "node_2" }
      }
    }), createRes);

    assert.equal(createRes.statusCode, 201);
    assert.equal(created[0].runId, "run_1");
    assert.equal(createRes.body.idempotent, false);
    assert.deepEqual(notifications, ["appr_created0000000000"]);
  });

  it("dedupes repeated child-run approval requests", async () => {
    const { created, handlers } = harness();
    const res = response();

    await handlers.createApproval(req({
      body: { payload: { childRunId: "run_child", nodeId: "node_1" } }
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.idempotent, true);
    assert.equal(res.body.approval.id, APPROVAL_ID);
    assert.equal(created.length, 0);
  });

  it("dedupes repeated engine approval requests from the runner bridge", async () => {
    const engineCardId = "appr_33333333333333333333";
    const { created, handlers } = harness({
      approvals: [{
        id: engineCardId,
        status: "pending",
        runId: "run_1",
        title: "Engine approval: improve · ship-gate",
        payload: { kind: "engine_approval", smithersRunId: "run_sm1", nodeId: "ship-gate" }
      }]
    });

    const dupRes = response();
    await handlers.createApproval(req({
      body: { runId: "run_1", payload: { kind: "engine_approval", smithersRunId: "run_sm1", nodeId: "ship-gate" } },
      tokenName: "runner"
    }), dupRes);
    assert.equal(dupRes.statusCode, 200);
    assert.equal(dupRes.body.idempotent, true);
    assert.equal(dupRes.body.approval.id, engineCardId);
    assert.equal(created.length, 0);

    // A different gate on the same engine run is a fresh card.
    const freshRes = response();
    await handlers.createApproval(req({
      body: { runId: "run_1", payload: { kind: "engine_approval", smithersRunId: "run_sm1", nodeId: "other-gate" } },
      tokenName: "runner"
    }), freshRes);
    assert.equal(freshRes.statusCode, 201);
    assert.equal(freshRes.body.idempotent, false);
    assert.equal(created.length, 1);
  });

  it("resolves web approvals and triggers terminal delivery only for terminal decisions", () => {
    const { deliveries, handlers, resolved } = harness();

    const approveRes = response();
    handlers.approve(req({ params: { id: APPROVAL_ID }, body: {} }), approveRes);
    assert.equal(approveRes.body.approval.status, "approved");
    assert.deepEqual(deliveries, []);

    const rejectId = "appr_22222222222222222222";
    const rejectHarness = harness({
      approvals: [{ id: rejectId, status: "pending", runId: "run_1", title: "Reject", payload: {} }]
    });
    const rejectRes = response();
    rejectHarness.handlers.reject(req({ params: { id: rejectId }, body: { comment: "No" } }), rejectRes);
    assert.equal(rejectRes.body.approval.status, "rejected");
    assert.deepEqual(rejectHarness.deliveries, ["run_1"]);
    assert.equal(rejectHarness.resolved[0].comment, "No");
    assert.equal(resolved[0].comment, "Approved from Web/API");
  });

  it("handles Telegram callback auth and validation failures", async () => {
    const unconfigured = harness({ telegramWebhookSecret: "" });
    const unconfiguredRes = response();
    await unconfigured.handlers.telegramWebhook(telegramReq(), unconfiguredRes);
    assert.equal(unconfiguredRes.statusCode, 503);

    const badSecret = harness();
    const badSecretRes = response();
    await badSecret.handlers.telegramWebhook(telegramReq({ secret: "wrong" }), badSecretRes);
    assert.equal(badSecretRes.statusCode, 401);

    const invalid = harness();
    const invalidRes = response();
    await invalid.handlers.telegramWebhook(telegramReq({ data: "bad" }), invalidRes);
    assert.equal(invalidRes.statusCode, 400);
    assert.deepEqual(invalid.callbackAnswers, [{ callbackQueryId: "cb_1", text: "invalid callback data format" }]);

    const wrongChat = harness();
    const wrongChatRes = response();
    await wrongChat.handlers.telegramWebhook(telegramReq({ chatId: "999" }), wrongChatRes);
    assert.equal(wrongChatRes.statusCode, 403);
  });

  it("resolves Telegram approvals and clears callback buttons", async () => {
    const { callbackAnswers, clearedCallbacks, deliveries, handlers, resolved } = harness();
    const res = response();

    await handlers.telegramWebhook(telegramReq({ data: `approval:request_changes:${APPROVAL_ID}` }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.approval.status, "changes_requested");
    assert.deepEqual(deliveries, ["run_1"]);
    assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Changes requested." }]);
    assert.deepEqual(clearedCallbacks, ["cb_1"]);
    assert.deepEqual(resolved[0], {
      id: APPROVAL_ID,
      decision: "changes_requested",
      actor: "telegram:alice",
      comment: "Changes requested from Telegram"
    });
  });

  it("reports already-resolved Telegram approvals without resolving again", async () => {
    const { callbackAnswers, clearedCallbacks, handlers, resolved } = harness();
    const res = response();

    await handlers.telegramWebhook(telegramReq({ data: "approval:approve:appr_11111111111111111111" }), res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, "approval is not pending");
    assert.deepEqual(callbackAnswers, [{ callbackQueryId: "cb_1", text: "Approval is already approved." }]);
    assert.deepEqual(clearedCallbacks, ["cb_1"]);
    assert.deepEqual(resolved, []);
  });
});
