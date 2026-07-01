import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SUPPORT_AGENT_MAX_OUTPUT_TOKENS,
  DEFAULT_SUPPORT_AGENT_TIMEOUT_MS,
  pickSupportAgentProvider,
  resolveSupportAgentConfig
} from "../src/supportAgentConfig.js";

describe("support agent config helpers", () => {
  it("normalizes explicit provider aliases", () => {
    assert.equal(pickSupportAgentProvider({ explicit: "smithers" }), "runner");
    assert.equal(pickSupportAgentProvider({ explicit: "claude" }), "anthropic");
    assert.equal(pickSupportAgentProvider({ explicit: "codex" }), "openai");
  });

  it("uses model and key availability when provider is unknown", () => {
    assert.equal(pickSupportAgentProvider({
      explicit: "auto",
      model: "claude-sonnet",
      hasAnthropic: true
    }), "anthropic");
    assert.equal(pickSupportAgentProvider({ explicit: "auto", hasOpenAi: true }), "openai");
    assert.equal(pickSupportAgentProvider({ explicit: "auto", hasAnthropic: true }), "anthropic");
    assert.equal(pickSupportAgentProvider({ explicit: "auto" }), "openai");
  });

  it("resolves runner defaults without requiring HTTP keys", () => {
    assert.deepEqual(resolveSupportAgentConfig({}, {}), {
      enabled: true,
      provider: "runner",
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: "",
      model: "gpt-4o-mini",
      timeoutMs: DEFAULT_SUPPORT_AGENT_TIMEOUT_MS,
      maxOutputTokens: DEFAULT_SUPPORT_AGENT_MAX_OUTPUT_TOKENS
    });
  });

  it("resolves HTTP provider URLs, keys, model, and numeric bounds", () => {
    assert.deepEqual(resolveSupportAgentConfig({}, {
      RUNYARD_HUB_SUPPORT_AGENT_ENABLED: "false",
      RUNYARD_HUB_SUPPORT_AGENT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "anthropic-key",
      RUNYARD_HUB_SUPPORT_AGENT_MODEL: "claude-3-5-sonnet",
      RUNYARD_HUB_SUPPORT_AGENT_TIMEOUT_MS: "1200",
      RUNYARD_HUB_SUPPORT_AGENT_MAX_OUTPUT_TOKENS: "900"
    }), {
      enabled: false,
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      apiKey: "anthropic-key",
      model: "claude-3-5-sonnet",
      timeoutMs: 1200,
      maxOutputTokens: 900
    });
  });
});
