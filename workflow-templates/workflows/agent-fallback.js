// Small workflow-local agent wrapper: try the preferred CLI agent, then retry
// once with the alternate CLI when the first one is unavailable/auth-limited.
//
// This is intentionally kept in workflow-templates rather than the Hub runtime:
// the Smithers engine only needs an object with generate(), so workflows can use
// it without changing orchestrator internals.

import { createPiAgentFromEnv } from "./pi-harness.js";

export { resolveAgentCli, resolvePiEndpoint } from "./pi-harness.js";

function errorText(error) {
  if (!error) return "";
  const parts = [
    error.message,
    error.stack,
    error.code,
    error.name,
    typeof error === "string" ? error : "",
    (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return "";
      }
    })()
  ];
  return parts.filter(Boolean).join("\n").toLowerCase();
}

export function shouldFallbackAgent(error) {
  const text = errorText(error);
  return [
    "429",
    "rate_limit",
    "rate limit",
    "monthly spend limit",
    "usage limit",
    "quota",
    "overage",
    "token_invalidated",
    "unauthorized",
    "401",
    "not logged in",
    "auth",
    "authentication",
    "api_error_status",
    "refusal",
    // Spawn failures (missing CLI binary) — lets a runner without the selected
    // harness on PATH degrade to the fallback CLI instead of failing the run.
    "enoent",
    // A pi endpoint whose named key env was never delivered (pi-harness.js
    // missingPiApiKeyMessage) — degrade instead of failing the run.
    "selects api key env"
  ].some((needle) => text.includes(needle));
}

function agentName(agent) {
  return agent?.cliEngine || agent?.constructor?.name || "agent";
}

export function withAgentFallback(primary, fallback, { label = "agent" } = {}) {
  return {
    cliEngine: `${agentName(primary)}+fallback:${agentName(fallback)}`,
    capabilities: primary?.capabilities,
    async generate(options = {}) {
      try {
        return await primary.generate(options);
      } catch (error) {
        if (!shouldFallbackAgent(error)) throw error;
        const reason = String(error?.message || error || "").split("\n")[0].slice(0, 300);
        const message = `[runyard] ${label}: ${agentName(primary)} failed (${reason}); retrying with ${agentName(fallback)}.\n`;
        try {
          options.onStderr?.(message);
        } catch {
          /* best-effort status only */
        }
        const fallbackOptions = {
          ...options,
          // Resume ids are CLI-specific. A Claude resume session must not be
          // passed to Codex, and vice versa.
          resumeSession: undefined,
          lastHeartbeat: undefined
        };
        return fallback.generate(fallbackOptions);
      }
    }
  };
}

export function createAgentFallbackPair({
  ClaudeCodeAgent,
  CodexAgent,
  PiAgent,
  primaryCli = "claude",
  workflow = "",
  env = process.env,
  label = "agent",
  cwd,
  claude = {},
  codex = {},
  pi = {}
} = {}) {
  if (!ClaudeCodeAgent || !CodexAgent) {
    throw new Error("createAgentFallbackPair requires ClaudeCodeAgent and CodexAgent constructors");
  }
  const systemPrompt = claude.systemPrompt || codex.systemPrompt || "";
  const timeoutMs = claude.timeoutMs || codex.timeoutMs;
  const claudeAgent = new ClaudeCodeAgent({
    ...claude,
    cwd: claude.cwd || cwd,
    ...(timeoutMs && !claude.timeoutMs ? { timeoutMs } : {}),
    ...(systemPrompt && !claude.systemPrompt ? { systemPrompt } : {})
  });
  const claudeWrites = claude.dangerouslySkipPermissions === true;
  const codexAgent = new CodexAgent({
    ...codex,
    cwd: codex.cwd || cwd,
    sandbox: codex.sandbox || (claudeWrites ? "danger-full-access" : "read-only"),
    nativeStructuredOutput: codex.nativeStructuredOutput ?? true,
    ...(timeoutMs && !codex.timeoutMs ? { timeoutMs } : {}),
    ...(systemPrompt && !codex.systemPrompt ? { systemPrompt } : {})
  });
  const cli = String(primaryCli || "claude").toLowerCase();
  const cliPair =
    cli === "codex"
      ? withAgentFallback(codexAgent, claudeAgent, { label })
      : withAgentFallback(claudeAgent, codexAgent, { label });
  if (cli !== "pi") return cliPair;
  // Pi primary (custom OpenAI-compatible endpoint), degrading to the
  // claude→codex pair when the endpoint errors or the pi CLI is missing.
  const piAgent = createPiAgentFromEnv({
    PiAgent,
    env,
    workflow,
    cwd: pi.cwd || cwd,
    systemPrompt: pi.systemPrompt || systemPrompt,
    timeoutMs: pi.timeoutMs || timeoutMs
  });
  return withAgentFallback(piAgent, cliPair, { label });
}
