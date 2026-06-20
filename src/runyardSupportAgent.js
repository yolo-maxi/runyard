// In-app conversational assistant for the Runyard Web Hub.
//
// Operators talk to this agent through a floating chat panel in /app. The
// model is briefed as the "Runyard user support agent" persona, sees the
// caller's current page/context, and may return a small action protocol
// the browser executes (navigate, click, fill, reload, api). The agent is
// "omnipotent" inside the app because the api action proxies through the
// caller's own session cookie — every action inherits their scopes.
//
// Two providers are supported and auto-selected from env:
//   - openai     POST https://api.openai.com/v1/chat/completions  (Codex/GPT)
//   - anthropic  POST https://api.anthropic.com/v1/messages       (Claude)
//
// The same pattern as runObstructionAnalysis.js — pluggable backend, single
// HTTP fetch, no streaming, with a generous JSON response budget.

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1500;

const PERSONA = `You are the Runyard user support agent — a hovering in-app copilot for Runyard, a self-hosted control plane for agent runs (codebase: smithers-hub).

Tone: concise, warm, no fluff. The operator can see your reply inline in the Hub UI; keep paragraphs short.

You can take actions inside the running web app by emitting a single fenced JSON block at the end of your reply with this exact shape:

\`\`\`json
{"actions":[{"tool":"<name>","args":{...}}]}
\`\`\`

Tools available to you:
- navigate({hash}): change the page (e.g. "#runs", "#workflows/<slug>", "#agents/agents/<slug>", "#approvals", "#runners", "#tokens", "#audit", "#settings"). Use the hash routes the user can see in the URL bar.
- click({selector}): click a DOM element by CSS selector inside the Hub UI. Prefer stable selectors ([data-view], button[type=submit], .primary).
- fill({selector,value}): set an input/textarea value and dispatch input/change events. The selector must match exactly one element.
- reload({}): re-render the current view from the API.
- api({method,path,body}): call any /api/* endpoint authenticated as the operator. Use this to trigger runs, query data, etc. Examples: GET /api/runs, GET /api/capabilities, POST /api/capabilities/<id>/run with body {"input":{...}}.
- chain multiple actions in order; the browser executes them sequentially.

Omit the actions block entirely if no action is needed. Never invent tools or args. If you are unsure what the operator wants, ask a clarifying question instead of guessing an action.

You always receive the operator's current context (route, hash, page title) — use it. When asked "what page am I on?" answer from context.`;

let injectedChat = null;

function parseBool(value, fallback = true) {
  if (value == null || value === "") return fallback;
  return !/^(0|false|off|no)$/i.test(String(value).trim());
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pickProvider({ explicit, model, hasOpenAi, hasAnthropic }) {
  const want = String(explicit || "").toLowerCase();
  if (want === "anthropic" || want === "claude") return "anthropic";
  if (want === "openai" || want === "codex" || want === "gpt") return "openai";
  if (/^claude/i.test(String(model || "")) && hasAnthropic) return "anthropic";
  if (hasOpenAi) return "openai";
  if (hasAnthropic) return "anthropic";
  return "openai";
}

function resolveConfig(config = {}) {
  const enabled = config.supportAgentEnabled ?? parseBool(process.env.SMITHERS_HUB_SUPPORT_AGENT_ENABLED, true);
  const explicitUrl = config.supportAgentUrl || process.env.SMITHERS_HUB_SUPPORT_AGENT_URL || "";
  const explicitProvider = config.supportAgentProvider || process.env.SMITHERS_HUB_SUPPORT_AGENT_PROVIDER || "";
  const openAiKey = config.openAiKey || process.env.OPENAI_API_KEY || "";
  const anthropicKey = config.anthropicKey || process.env.ANTHROPIC_API_KEY || "";
  const explicitKey = config.supportAgentApiKey || process.env.SMITHERS_HUB_SUPPORT_AGENT_API_KEY || "";
  const model = config.supportAgentModel || process.env.SMITHERS_HUB_SUPPORT_AGENT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const provider = pickProvider({
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
    timeoutMs: safeNumber(config.supportAgentTimeoutMs || process.env.SMITHERS_HUB_SUPPORT_AGENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutputTokens: safeNumber(config.supportAgentMaxOutputTokens || process.env.SMITHERS_HUB_SUPPORT_AGENT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS)
  };
}

export function supportAgentConfigured(config = {}) {
  if (injectedChat) return true;
  const c = resolveConfig(config);
  return Boolean(c.enabled && c.url && c.apiKey && c.model);
}

export function supportAgentInfo(config = {}) {
  const c = resolveConfig(config);
  return {
    configured: supportAgentConfigured(config),
    provider: c.provider,
    model: c.model,
    enabled: c.enabled
  };
}

export function setSupportAgentChatForTest(chat) {
  injectedChat = typeof chat === "function" ? chat : null;
}

function buildContextLine(context = {}) {
  const view = context.view || context.route?.view || "";
  const hash = context.hash || (context.route ? `#${context.route.raw || ""}` : "");
  const title = context.title || "";
  const url = context.url || "";
  const params = context.params && typeof context.params === "object" ? context.params : {};
  const paramSummary = Object.entries(params)
    .filter(([, value]) => value != null && value !== "")
    .slice(0, 8)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
    .join(", ");
  return [
    `Current view: ${view || "unknown"}`,
    hash ? `Hash: ${hash}` : "",
    title ? `Title: ${title}` : "",
    url ? `URL: ${url}` : "",
    paramSummary ? `Params: ${paramSummary}` : ""
  ].filter(Boolean).join("\n");
}

function sanitizeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const cleaned = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const role = ["user", "assistant", "system"].includes(entry.role) ? entry.role : "user";
    const content = typeof entry.content === "string" ? entry.content : String(entry.content ?? "");
    const text = content.slice(0, 16_000);
    if (!text.trim()) continue;
    cleaned.push({ role, content: text });
  }
  return cleaned.slice(-24);
}

async function callOpenAi(provider, { messages, system, signal }) {
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.2,
      max_tokens: provider.maxOutputTokens
    }),
    signal
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`support agent LLM request failed (${response.status}): ${truncate(text, 240)}`);
  }
  const data = await response.json();
  const reply =
    data?.choices?.[0]?.message?.content
    || data?.output_text
    || data?.output?.[0]?.content?.[0]?.text
    || "";
  return { reply: String(reply || ""), raw: data };
}

async function callAnthropic(provider, { messages, system, signal }) {
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: provider.model,
      system,
      max_tokens: provider.maxOutputTokens,
      messages: messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }))
    }),
    signal
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`support agent LLM request failed (${response.status}): ${truncate(text, 240)}`);
  }
  const data = await response.json();
  const reply = Array.isArray(data?.content)
    ? data.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n").trim()
    : "";
  return { reply, raw: data };
}

function truncate(text, max = 240) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export async function chatWithSupportAgent({ messages, context, config = {}, signal } = {}) {
  const resolved = resolveConfig(config);
  const safeMessages = sanitizeMessages(messages);
  if (!safeMessages.length) throw new Error("support agent requires at least one user message");
  const contextLine = buildContextLine(context || {});
  const system = `${PERSONA}\n\n--- Live operator context ---\n${contextLine || "(no context provided)"}`;
  if (injectedChat) {
    const reply = await injectedChat({ system, messages: safeMessages, context });
    return {
      reply: String(reply || ""),
      provider: "injected",
      model: "injected"
    };
  }
  if (!resolved.enabled) throw new Error("support agent is disabled");
  if (!resolved.url || !resolved.apiKey || !resolved.model) {
    throw new Error("support agent is not configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY)");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener?.("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
  try {
    const out = resolved.provider === "anthropic"
      ? await callAnthropic(resolved, { messages: safeMessages, system, signal: controller.signal })
      : await callOpenAi(resolved, { messages: safeMessages, system, signal: controller.signal });
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

export const __test = { resolveConfig, sanitizeMessages, buildContextLine, PERSONA };
