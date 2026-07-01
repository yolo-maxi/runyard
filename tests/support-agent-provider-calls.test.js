import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  callAnthropicProvider,
  callOpenAiProvider
} from "../src/supportAgentProviderCalls.js";

const provider = {
  url: "https://example.test/chat",
  apiKey: "key_1",
  model: "model_1",
  maxOutputTokens: 50
};

describe("support agent provider calls", () => {
  it("calls OpenAI-compatible providers and parses replies", async () => {
    const calls = [];
    const result = await callOpenAiProvider(provider, {
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "hi" } }] })
        };
      }
    });

    assert.equal(result.reply, "hi");
    assert.equal(calls[0].url, provider.url);
    assert.equal(calls[0].init.headers.authorization, "Bearer key_1");
  });

  it("calls Anthropic-compatible providers and formats HTTP failures", async () => {
    await assert.rejects(
      callAnthropicProvider(provider, {
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          text: async () => "provider unavailable"
        })
      }),
      /support agent LLM request failed \(503\): provider unavailable/
    );
  });
});
