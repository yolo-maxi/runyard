import { env } from "./env.js";
import { assertSafeHttpTarget } from "./httpTargetSafety.js";
import { redactResponseEndpointText } from "./runResponseEndpointPayload.js";

export const DEFAULT_RESPONSE_ENDPOINT_TIMEOUT_MS = 10_000;

export function safeResponseEndpointError(message) {
  return redactResponseEndpointText(message);
}

export async function postJson(url, body, options, { fetchImpl, timeoutMs, headers = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: options?.method || "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverHttpResponseEndpoint(endpoint, payload, {
  allowPrivateTargets = false,
  fetchImpl,
  lookup,
  timeoutMs
}) {
  const config = endpoint.config || {};
  const method = String(config.method || "POST").toUpperCase();
  // Slice 1 already validated method in {POST, PUT}; reject anything else
  // defensively so a malformed row cannot issue an unplanned GET.
  if (method !== "POST" && method !== "PUT") {
    return { ok: false, error: `unsupported http method: ${method}` };
  }
  try {
    await assertSafeHttpTarget(config.url, { allowPrivateTargets, lookup });
  } catch (error) {
    return { ok: false, error: safeResponseEndpointError(error?.message || error) };
  }
  const result = await postJson(
    config.url,
    payload,
    { method },
    { fetchImpl, timeoutMs, headers: config.headers || {} }
  );
  if (result.ok) return { ok: true, status: result.status };
  if (result.status) {
    return { ok: false, status: result.status, error: `http delivery returned status ${result.status}` };
  }
  return {
    ok: false,
    error: `http delivery failed: ${safeResponseEndpointError(result.error || "unknown error")}`
  };
}

export function telegramTerminalMessage(run, payload, baseUrl) {
  const title = run.capabilityName || run.capabilitySlug || "Runyard run";
  const status = String(run.status || "terminal").toUpperCase();
  const link = `${baseUrl || ""}/app#runs/${run.id}`;
  const errorLine = payload.error ? `\nError: ${payload.error}` : "";
  const artifactLine = payload.artifacts.length
    ? `\nArtifacts: ${payload.artifacts.length}`
    : "";
  return `Runyard: ${title}\nRun ${run.id} → ${status}${errorLine}${artifactLine}\n${link}`;
}

export async function deliverTelegramResponseEndpoint(endpoint, run, payload, {
  fetchImpl,
  timeoutMs,
  telegramBotToken,
  baseUrl
}) {
  if (!telegramBotToken) {
    return {
      ok: false,
      error:
        "telegram delivery skipped: TELEGRAM_BOT_TOKEN (or SMITHERS_TELEGRAM_BOT_TOKEN) is not configured"
    };
  }
  const config = endpoint.config || {};
  const body = {
    chat_id: config.chatId,
    text: telegramTerminalMessage(run, payload, baseUrl),
    ...(config.threadId != null ? { message_thread_id: config.threadId } : {}),
    ...(config.parseMode ? { parse_mode: config.parseMode } : {})
  };
  const result = await postJson(
    `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
    body,
    { method: "POST" },
    { fetchImpl, timeoutMs }
  );
  if (result.ok) return { ok: true, status: result.status };
  if (result.status) {
    return { ok: false, status: result.status, error: `telegram delivery returned status ${result.status}` };
  }
  return {
    ok: false,
    error: `telegram delivery failed: ${safeResponseEndpointError(result.error || "unknown error")}`
  };
}

export async function deliverResponseEndpointTransport(endpoint, run, payload, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_RESPONSE_ENDPOINT_TIMEOUT_MS;
  const telegramBotToken = options.telegramBotToken ?? env.telegramBotToken;
  const baseUrl = options.baseUrl ?? env.baseUrl;
  if (endpoint.type === "http") {
    return deliverHttpResponseEndpoint(endpoint, payload, {
      allowPrivateTargets: options.allowPrivateTargets === true,
      fetchImpl,
      lookup: options.lookup,
      timeoutMs
    });
  }
  if (endpoint.type === "telegram") {
    return deliverTelegramResponseEndpoint(endpoint, run, payload, {
      fetchImpl,
      timeoutMs,
      telegramBotToken,
      baseUrl
    });
  }
  return { ok: false, error: `unknown response endpoint type: ${endpoint.type}` };
}
