import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anthropicRequest,
  openAiRequest,
  parseAnthropicReply,
  parseOpenAiReply,
  supportAgentHttpError
} from "../src/supportAgentHttpProviders.js";

describe("support agent HTTP provider helpers", () => {
  const provider = {
    url: "https://example.test/chat",
    apiKey: "key_1",
    model: "model_1",
    maxOutputTokens: 123
  };

  it("builds OpenAI-compatible requests", () => {
    const request = openAiRequest(provider, {
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }]
    });
    const body = JSON.parse(request.init.body);

    assert.equal(request.url, provider.url);
    assert.equal(request.init.headers.authorization, "Bearer key_1");
    assert.equal(body.model, "model_1");
    assert.equal(body.max_tokens, 123);
    assert.deepEqual(body.messages, [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" }
    ]);
  });

  it("builds Anthropic-compatible requests", () => {
    const request = anthropicRequest(provider, {
      system: "system prompt",
      messages: [
        { role: "system", content: "skip" },
        { role: "assistant", content: "hi" },
        { role: "tool", content: "tool output" }
      ]
    });
    const body = JSON.parse(request.init.body);

    assert.equal(request.init.headers["x-api-key"], "key_1");
    assert.equal(request.init.headers["anthropic-version"], "2023-06-01");
    assert.equal(body.system, "system prompt");
    assert.deepEqual(body.messages, [
      { role: "assistant", content: "hi" },
      { role: "user", content: "tool output" }
    ]);
  });

  it("parses provider replies", () => {
    assert.equal(parseOpenAiReply({ choices: [{ message: { content: "hello" } }] }), "hello");
    assert.equal(parseOpenAiReply({ output_text: "fallback" }), "fallback");
    assert.equal(parseAnthropicReply({ content: [
      { type: "text", text: "hello" },
      { type: "tool_use", text: "skip" },
      { type: "text", text: "world" }
    ] }), "hello\nworld");
    assert.equal(parseAnthropicReply({}), "");
  });

  it("formats compact HTTP errors", async () => {
    const error = await supportAgentHttpError({
      status: 500,
      text: async () => " provider   failed ".repeat(30)
    });

    assert.match(error.message, /^support agent LLM request failed \(500\): provider failed/);
    assert.equal(error.message.length <= 290, true);
  });
});
