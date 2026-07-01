import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SUPPORT_AGENT_CAPABILITY_SLUG,
  SUPPORT_AGENT_PERSONA,
  buildSupportContextLine,
  compactText,
  extractRunnerReply,
  sanitizeSupportMessages,
  supportAgentSystemPrompt
} from "../src/supportAgentPresentation.js";

describe("support agent presentation helpers", () => {
  it("sanitizes chat turns to bounded supported roles", () => {
    const messages = Array.from({ length: 26 }, (_, index) => ({
      role: index % 2 ? "assistant" : "tool",
      content: index === 0 ? "x".repeat(20_000) : `message ${index}`
    }));

    const sanitized = sanitizeSupportMessages(messages);

    assert.equal(sanitized.length, 24);
    assert.deepEqual(sanitized[0], { role: "user", content: "message 2" });
    assert.equal(sanitized.at(-1).role, "assistant");
  });

  it("builds a compact context line with route and live screen data", () => {
    const line = buildSupportContextLine({
      route: { view: "runs", raw: "runs/run_1" },
      title: "Run detail",
      params: { id: "run_1", empty: "" },
      live: "Run run_1 failed"
    });

    assert.match(line, /Current view: runs/);
    assert.match(line, /Hash: #runs\/run_1/);
    assert.match(line, /Params: id=run_1/);
    assert.match(line, /Live app data/);
  });

  it("assembles the system prompt and extracts runner replies", () => {
    const prompt = supportAgentSystemPrompt({ view: "approvals" });
    assert.match(prompt, /Runyard user support agent/);
    assert.match(prompt, /Current view: approvals/);
    assert.equal(SUPPORT_AGENT_CAPABILITY_SLUG, "runyard-support-agent");
    assert.match(SUPPORT_AGENT_PERSONA, /Button rules/);

    assert.equal(extractRunnerReply({ output: { outputs: { support: { reply: " ok " } } } }), "ok");
    assert.equal(extractRunnerReply({ output: { answer: "fallback" } }), "fallback");
    assert.equal(extractRunnerReply({ output: {} }), "");
  });

  it("compacts long text for provider error messages", () => {
    assert.equal(compactText(" a   b "), "a b");
    assert.equal(compactText("abcdef", 5), "ab...");
  });
});
