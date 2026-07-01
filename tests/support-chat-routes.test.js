import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSupportChatHandlers } from "../src/supportChatRoutes.js";
import { mockResponse as response } from "./response.js";

function req({ body = {}, token = { id: "tok_1", name: "operator" } } = {}) {
  return { body, token };
}

function harness(overrides = {}) {
  const audits = [];
  const chatCalls = [];
  const handlers = createSupportChatHandlers({
    buildSupportLiveContext: (context) => overrides.live || { kind: context.view || "unknown", text: "live run data" },
    chatWithSupportAgent: async (input) => {
      chatCalls.push(input);
      if (overrides.chatError) throw overrides.chatError;
      return overrides.chatResult || { reply: "hello", provider: "test", model: "model-1" };
    },
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    supportAgentInfo: () => ({ configured: true, provider: "test" })
  });
  return { audits, chatCalls, handlers };
}

describe("support chat route helpers", () => {
  it("reports support agent status", () => {
    const { handlers } = harness();
    const res = response();

    handlers.status(req(), res);

    assert.deepEqual(res.body, { configured: true, provider: "test" });
  });

  it("rejects requests without messages", async () => {
    const { handlers } = harness();
    const res = response();

    await handlers.chat(req({ body: { messages: [] } }), res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "messages array required");
  });

  it("enriches context, records audit, and returns the agent response", async () => {
    const { audits, chatCalls, handlers } = harness();
    const res = response();

    await handlers.chat(req({
      body: {
        messages: [{ role: "user", content: "what happened?" }],
        context: { view: "runs", runId: "run_1" }
      }
    }), res);

    assert.equal(res.body.reply, "hello");
    assert.deepEqual(chatCalls[0], {
      messages: [{ role: "user", content: "what happened?" }],
      context: { view: "runs", runId: "run_1", live: "live run data" }
    });
    assert.deepEqual(audits[0], {
      actor: "operator",
      action: "chat.message",
      target: "support-agent:test/model-1",
      detail: { view: "runs", turns: 1, contextKind: "runs" }
    });
  });

  it("falls back to token ids in audit records", async () => {
    const { audits, handlers } = harness();
    const res = response();

    await handlers.chat(req({
      body: { messages: [{ role: "user", content: "what happened?" }] },
      token: { id: "tok_only" }
    }), res);

    assert.equal(audits[0].actor, "tok_only");
  });

  it("returns 503 when the support agent fails", async () => {
    const { handlers } = harness({ chatError: new Error("provider down") });
    const res = response();

    await handlers.chat(req({ body: { messages: [{ role: "user", content: "hi" }] } }), res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "provider down");
  });
});
