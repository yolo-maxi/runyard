// In-app conversational assistant for the Runyard Web Hub.
//
// Operators talk to this agent through a floating chat panel in /app. The
// model is briefed as the "Runyard user support agent" persona, sees the
// caller's current page/context, and may return proposed action buttons.
// The browser only executes app-changing actions after the operator clicks a
// button, so a question stays a question instead of becoming a run.
//
// The default provider is the Hub runner pool: /api/chat queues a tiny
// internal Smithers workflow and the subscribed on-runner CLI agent answers it.
// Direct HTTP providers remain as explicit opt-ins for installs that want them:
//   - openai     POST https://api.openai.com/v1/chat/completions  (Codex/GPT)
//   - anthropic  POST https://api.anthropic.com/v1/messages       (Claude)
//
// The HTTP path follows runObstructionAnalysis.js — pluggable backend, single
// HTTP fetch, no streaming, with a generous JSON response budget.

import { addRunEvent, createRun, getCapability, getRun, supportRunnerAvailability } from "./db.js";
import {
  SUPPORT_AGENT_CAPABILITY_SLUG,
  SUPPORT_AGENT_PERSONA,
  extractRunnerReply,
  sanitizeSupportMessages,
  supportAgentSystemPrompt,
  buildSupportContextLine
} from "./supportAgentPresentation.js";
import { resolveSupportAgentConfig } from "./supportAgentConfig.js";
import {
  callAnthropicProvider,
  callOpenAiProvider
} from "./supportAgentProviderCalls.js";
import { createSupportAgentRunnerProvider } from "./supportAgentRunnerProvider.js";

let injectedChat = null;

const resolveConfig = resolveSupportAgentConfig;

export function supportAgentConfigured(config = {}) {
  if (injectedChat) return true;
  const c = resolveConfig(config);
  if (!c.enabled) return false;
  if (c.provider === "runner") return supportRunnerAvailability().available;
  return Boolean(c.enabled && c.url && c.apiKey && c.model);
}

export function supportAgentInfo(config = {}) {
  const c = resolveConfig(config);
  const runner = c.provider === "runner" ? supportRunnerAvailability() : null;
  return {
    configured: supportAgentConfigured(config),
    provider: c.provider,
    model: c.provider === "runner" ? SUPPORT_AGENT_CAPABILITY_SLUG : c.model,
    enabled: c.enabled,
    ...(runner ? { runner } : {})
  };
}

export function setSupportAgentChatForTest(chat) {
  injectedChat = typeof chat === "function" ? chat : null;
}

const callRunnerProvider = createSupportAgentRunnerProvider({
  addRunEvent,
  createRun,
  getCapability,
  getRun,
  supportRunnerAvailability
});

export async function chatWithSupportAgent({ messages, context, config = {}, signal } = {}) {
  const resolved = resolveConfig(config);
  const safeMessages = sanitizeSupportMessages(messages);
  if (!safeMessages.length) throw new Error("support agent requires at least one user message");
  const system = supportAgentSystemPrompt(context || {});
  if (injectedChat) {
    const reply = await injectedChat({ system, messages: safeMessages, context });
    return {
      reply: String(reply || ""),
      provider: "injected",
      model: "injected"
    };
  }
  if (!resolved.enabled) throw new Error("support agent is disabled");
  if (resolved.provider === "runner") {
    const out = await callRunnerProvider(resolved, { messages: safeMessages, system, context, signal });
    return {
      reply: out.reply,
      provider: "runner",
      model: SUPPORT_AGENT_CAPABILITY_SLUG
    };
  }
  if (!resolved.url || !resolved.apiKey || !resolved.model) {
    throw new Error("support agent HTTP provider is not configured");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener?.("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
  try {
    const out = resolved.provider === "anthropic"
      ? await callAnthropicProvider(resolved, { messages: safeMessages, system, signal: controller.signal })
      : await callOpenAiProvider(resolved, { messages: safeMessages, system, signal: controller.signal });
    return {
      reply: out.reply,
      provider: resolved.provider,
      model: resolved.model
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.("abort", onAbort);
  }
}

export const __test = {
  resolveConfig,
  sanitizeMessages: sanitizeSupportMessages,
  buildContextLine: buildSupportContextLine,
  extractRunnerReply,
  PERSONA: SUPPORT_AGENT_PERSONA,
  SUPPORT_AGENT_CAPABILITY_SLUG
};
