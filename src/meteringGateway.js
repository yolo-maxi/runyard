// Metering gateway primitives: per-run gateway tokens, provider usage
// extraction, and the claim-time "gateway pin" that routes a run's child
// agents through the Hub instead of handing them a provider key.
//
// The token is stateless: `ryg_<runId>.<hmac(secret, runId)>`. The Hub can
// mint it at claim time and verify it on every gateway call without storing
// anything; possession proves the Hub issued it for that exact run, and the
// gateway additionally requires the run to still be active. The signing
// secret is the Hub's persistent session secret.
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveHarnessSelection } from "./runHarnessSelection.js";

export const GATEWAY_TOKEN_PREFIX = "ryg_";
export const GATEWAY_TOKEN_ENV = "RUNYARD_GATEWAY_TOKEN";
export const GATEWAY_OPENAI_PATH = "/api/gateway/openai/v1";
export const GATEWAY_ANTHROPIC_PATH = "/api/gateway/anthropic";
// The pi provider label child agents are pinned to; the runner materializes a
// per-run pi models.json whose ONLY provider is this one (src/runnerGateway.js).
export const GATEWAY_PI_PROVIDER = "runyard-gateway";

function gatewayMac(runId, secret) {
  return createHmac("sha256", String(secret)).update(`runyard-metering-gateway:${runId}`).digest("hex");
}

export function gatewayRunToken(runId, secret) {
  if (!runId || !secret) return "";
  return `${GATEWAY_TOKEN_PREFIX}${runId}.${gatewayMac(runId, secret)}`;
}

// Returns the runId the token was minted for, or null.
export function verifyGatewayToken(token, secret) {
  if (!secret) return null;
  const raw = String(token || "");
  if (!raw.startsWith(GATEWAY_TOKEN_PREFIX)) return null;
  const rest = raw.slice(GATEWAY_TOKEN_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const runId = rest.slice(0, dot);
  const mac = Buffer.from(rest.slice(dot + 1));
  const expected = Buffer.from(gatewayMac(runId, secret));
  if (mac.length !== expected.length) return null;
  return timingSafeEqual(mac, expected) ? runId : null;
}

// Gateway calls authenticate like the provider they imitate: OpenAI-style
// `Authorization: Bearer`, Anthropic-style `x-api-key`.
export function gatewayRequestToken(req) {
  const auth = String(req.headers?.authorization || "");
  if (/^bearer /i.test(auth)) return auth.slice(7).trim();
  return String(req.headers?.["x-api-key"] || "").trim();
}

function count(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
}

// Some OpenAI-compatible upstreams (OpenRouter, Venice) report the call's
// dollar cost on the usage object; when present it beats any price table.
function usageCostMicros(usage) {
  const cost = Number(usage?.cost);
  if (Number.isFinite(cost) && cost >= 0 && cost < 100_000) return Math.round(cost * 1_000_000);
  return null;
}

export function openAiUsage(json) {
  const usage = json?.usage;
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = count(usage.prompt_tokens ?? usage.promptTokens);
  const completionTokens = count(usage.completion_tokens ?? usage.completionTokens);
  if (promptTokens + completionTokens === 0) return null;
  const costMicros = usageCostMicros(usage);
  return {
    promptTokens,
    completionTokens,
    totalTokens: count(usage.total_tokens ?? usage.totalTokens) || promptTokens + completionTokens,
    ...(costMicros != null ? { costMicros } : {}),
    model: String(json.model || ""),
    requestId: String(json.id || "") || null
  };
}

export function anthropicUsage(json) {
  const usage = json?.usage;
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = count(usage.input_tokens);
  const completionTokens = count(usage.output_tokens);
  if (promptTokens + completionTokens === 0) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    model: String(json.model || ""),
    requestId: String(json.id || "") || null,
    metadata: {
      ...(usage.cache_read_input_tokens ? { cacheReadTokens: count(usage.cache_read_input_tokens) } : {}),
      ...(usage.cache_creation_input_tokens ? { cacheWriteTokens: count(usage.cache_creation_input_tokens) } : {})
    }
  };
}

function sseJsonPayloads(text) {
  const payloads = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      // Partial/garbled frame (e.g. truncated by the scan cap) — skip.
    }
  }
  return payloads;
}

// Extract usage from a buffered SSE stream.
//  - openai flavor: pi's client always requests stream_options.include_usage,
//    so the final chunk carries `usage` (some providers put it on the choice).
//  - anthropic flavor: message_start carries input tokens + model,
//    message_delta carries cumulative output tokens.
export function sseUsage(text, flavor = "openai") {
  const payloads = sseJsonPayloads(text);
  if (flavor === "anthropic") {
    let promptTokens = 0;
    let completionTokens = 0;
    let model = "";
    let requestId = null;
    let sawUsage = false;
    for (const payload of payloads) {
      if (payload.type === "message_start" && payload.message) {
        promptTokens = count(payload.message.usage?.input_tokens);
        completionTokens = count(payload.message.usage?.output_tokens) || completionTokens;
        model = String(payload.message.model || model);
        requestId = String(payload.message.id || "") || requestId;
        sawUsage = Boolean(payload.message.usage);
      }
      if (payload.type === "message_delta" && payload.usage) {
        completionTokens = count(payload.usage.output_tokens) || completionTokens;
        sawUsage = true;
      }
    }
    if (!sawUsage || promptTokens + completionTokens === 0) return null;
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, model, requestId };
  }
  let found = null;
  for (const payload of payloads) {
    const direct = openAiUsage(payload);
    if (direct) found = direct;
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      const fallback = openAiUsage({ ...payload, usage: choice?.usage });
      if (fallback) found = fallback;
    }
  }
  return found;
}

// Claim-time gateway pin. Returns null unless the run explicitly selected
// gateway metering AND the selection is complete enough for the Hub to own
// the upstream call (endpoint URL + named key + model). The returned
// `excludeSecretNames` tells the claim path to withhold the provider key from
// the child env — the whole point of the gateway.
export function runGatewayPin({ run, capability, secret }) {
  if (!run?.id || !secret) return null;
  const { selection } = resolveHarnessSelection({ capability, input: run.input || {} });
  if (selection.metering !== "gateway") return null;
  const harness = selection.agentHarness || (selection.piProvider || selection.piModel ? "pi" : "");
  if (harness !== "pi") return null;
  if (!selection.piModel || !selection.piBaseUrl || !selection.piApiKeyEnv) return null;
  return {
    kind: "openai",
    path: GATEWAY_OPENAI_PATH,
    provider: GATEWAY_PI_PROVIDER,
    model: selection.piModel,
    tokenEnv: GATEWAY_TOKEN_ENV,
    token: gatewayRunToken(run.id, secret),
    excludeSecretNames: [selection.piApiKeyEnv]
  };
}

// Issues that make a gateway-metering selection unusable; surfaced by run
// preflight as blockers so the run never launches half-pinned.
export function gatewayMeteringIssues(selection = {}) {
  if (selection.metering !== "gateway") return [];
  const issues = [];
  const harness = selection.agentHarness || (selection.piProvider || selection.piModel ? "pi" : "");
  if (harness !== "pi") {
    issues.push('metering "gateway" currently requires the pi harness (agentHarness "pi" or a piProvider/piModel selection); claude/codex CLI runs are runner-observed only');
  }
  if (!selection.piModel) issues.push('metering "gateway" requires piModel so the gateway pin can advertise the model to the child agent');
  if (!selection.piBaseUrl) issues.push('metering "gateway" requires piBaseUrl — the Hub must know the upstream endpoint to forward to');
  if (!selection.piApiKeyEnv) issues.push('metering "gateway" requires piApiKeyEnv naming the Hub secret that holds the endpoint key');
  return issues;
}
