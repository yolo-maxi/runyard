import { parseBool, positiveNumber } from "./configParsing.js";

export const DEFAULT_SUPPORT_AGENT_TIMEOUT_MS = 45_000;
export const DEFAULT_SUPPORT_AGENT_MAX_OUTPUT_TOKENS = 1500;

export function pickSupportAgentProvider({ explicit, model, hasOpenAi, hasAnthropic }) {
  const want = String(explicit || "").toLowerCase();
  if (!want) return "runner";
  if (want === "runner" || want === "smithers" || want === "subscription") return "runner";
  if (want === "anthropic" || want === "claude") return "anthropic";
  if (want === "openai" || want === "codex" || want === "gpt") return "openai";
  if (/^claude/i.test(String(model || "")) && hasAnthropic) return "anthropic";
  if (hasOpenAi) return "openai";
  if (hasAnthropic) return "anthropic";
  return "openai";
}

export function resolveSupportAgentConfig(config = {}, env = process.env) {
  const enabled =
    config.supportAgentEnabled ??
    parseBool(
      env.RUNYARD_HUB_SUPPORT_AGENT_ENABLED ?? env.SMITHERS_HUB_SUPPORT_AGENT_ENABLED,
      true
    );
  const explicitUrl =
    config.supportAgentUrl ||
    env.RUNYARD_HUB_SUPPORT_AGENT_URL ||
    env.SMITHERS_HUB_SUPPORT_AGENT_URL ||
    "";
  const explicitProvider =
    config.supportAgentProvider ||
    env.RUNYARD_HUB_SUPPORT_AGENT_PROVIDER ||
    env.SMITHERS_HUB_SUPPORT_AGENT_PROVIDER ||
    "runner";
  const openAiKey = config.openAiKey || env.OPENAI_API_KEY || "";
  const anthropicKey = config.anthropicKey || env.ANTHROPIC_API_KEY || "";
  const explicitKey =
    config.supportAgentApiKey ||
    env.RUNYARD_HUB_SUPPORT_AGENT_API_KEY ||
    env.SMITHERS_HUB_SUPPORT_AGENT_API_KEY ||
    "";
  const model =
    config.supportAgentModel ||
    env.RUNYARD_HUB_SUPPORT_AGENT_MODEL ||
    env.SMITHERS_HUB_SUPPORT_AGENT_MODEL ||
    env.OPENAI_MODEL ||
    "gpt-4o-mini";
  const provider = pickSupportAgentProvider({
    explicit: explicitProvider,
    model,
    hasOpenAi: Boolean(explicitKey || openAiKey),
    hasAnthropic: Boolean(explicitKey || anthropicKey)
  });
  const apiKey = explicitKey || (provider === "anthropic" ? anthropicKey : openAiKey);
  const url = explicitUrl || (provider === "anthropic"
    ? "https://api.anthropic.com/v1/messages"
    : "https://api.openai.com/v1/chat/completions");
  return {
    enabled,
    provider,
    url,
    apiKey,
    model,
    timeoutMs: positiveNumber(
      config.supportAgentTimeoutMs ||
        env.RUNYARD_HUB_SUPPORT_AGENT_TIMEOUT_MS ||
        env.SMITHERS_HUB_SUPPORT_AGENT_TIMEOUT_MS,
      DEFAULT_SUPPORT_AGENT_TIMEOUT_MS
    ),
    maxOutputTokens: positiveNumber(
      config.supportAgentMaxOutputTokens ||
        env.RUNYARD_HUB_SUPPORT_AGENT_MAX_OUTPUT_TOKENS ||
        env.SMITHERS_HUB_SUPPORT_AGENT_MAX_OUTPUT_TOKENS,
      DEFAULT_SUPPORT_AGENT_MAX_OUTPUT_TOKENS
    )
  };
}
