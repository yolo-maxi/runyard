// Validation and redaction helpers for per-run response endpoints.
//
// Slice 1 contract: callers MAY attach an optional `responseEndpoint` to
// `POST /api/capabilities/:id/run`. The endpoint is server-validated, stored
// in its own normalized table (see db.js `run_response_endpoints`), and
// surfaced back to callers only as a redacted summary. The raw config (URLs
// with query secrets, bearer headers, telegram chatIds) is held for delivery
// only and never echoed into API responses, run events, or audit detail.
//
// Slice 2 will add the actual outbound delivery — see
// `specs/run-response-endpoints.md` for the full contract.

const ALLOWED_TYPES = new Set(["http", "telegram"]);
const HTTP_METHODS = new Set(["POST", "PUT"]);
const SAFE_HTTP_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
// Header values are stored verbatim for delivery but never surfaced in audit
// summaries. The list below is what the summary masks by name.
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token"
]);
const URL_REDACT_QUERY_KEYS = new Set([
  "token",
  "secret",
  "api_key",
  "apikey",
  "key",
  "auth",
  "access_token",
  "password",
  "signature"
]);
const TELEGRAM_PARSE_MODES = new Set(["MarkdownV2", "Markdown", "HTML"]);
const MAX_HEADER_COUNT = 16;
const MAX_HEADER_VALUE_BYTES = 1024;
const MAX_URL_BYTES = 2048;
const MAX_CHAT_ID_BYTES = 64;

function fail(message) {
  return { ok: false, error: `responseEndpoint: ${message}` };
}

// Parse and validate a caller-supplied `responseEndpoint` block. Returns
// `{ ok: true, value: null }` when the caller did not provide one,
// `{ ok: true, value: { type, config } }` for a valid endpoint, or
// `{ ok: false, error }` for anything malformed. The returned `config` is the
// canonical, server-normalized shape suitable for direct JSON storage.
export function parseResponseEndpoint(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("must be an object");
  const type = String(raw.type || "").toLowerCase().trim();
  if (!ALLOWED_TYPES.has(type)) {
    return fail(`type must be one of: ${[...ALLOWED_TYPES].join(", ")}`);
  }
  const config = raw.config && typeof raw.config === "object" && !Array.isArray(raw.config) ? raw.config : null;
  if (!config) return fail("config object is required");
  if (type === "http") return parseHttpConfig(config);
  if (type === "telegram") return parseTelegramConfig(config);
  return fail(`unsupported type: ${type}`);
}

function parseHttpConfig(config) {
  const url = String(config.url || "").trim();
  if (!url) return fail("config.url is required");
  if (url.length > MAX_URL_BYTES) return fail("config.url is too long");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail("config.url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("config.url must use http or https");
  }
  const method = String(config.method || "POST").toUpperCase().trim();
  if (!HTTP_METHODS.has(method)) return fail("config.method must be POST or PUT");
  let headers = {};
  if (config.headers != null) {
    if (typeof config.headers !== "object" || Array.isArray(config.headers)) {
      return fail("config.headers must be an object");
    }
    const entries = Object.entries(config.headers);
    if (entries.length > MAX_HEADER_COUNT) return fail("config.headers has too many entries");
    for (const [name, value] of entries) {
      if (!SAFE_HTTP_HEADER_NAME.test(name)) return fail(`config.headers has invalid header name: ${name}`);
      if (typeof value !== "string") return fail("config.headers values must be strings");
      if (Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES) {
        return fail(`config.headers value too large for ${name}`);
      }
      headers[name] = value;
    }
  }
  return { ok: true, value: { type: "http", config: { url, method, headers } } };
}

function parseTelegramConfig(config) {
  const chatIdRaw = config.chatId ?? config.chat_id;
  if (chatIdRaw == null) return fail("config.chatId is required");
  if (typeof chatIdRaw !== "string" && typeof chatIdRaw !== "number") {
    return fail("config.chatId must be a string or number");
  }
  const chatId = String(chatIdRaw).trim();
  if (!chatId) return fail("config.chatId is required");
  if (chatId.length > MAX_CHAT_ID_BYTES) return fail("config.chatId is too long");
  const clean = { chatId };
  const threadRaw = config.threadId ?? config.thread_id;
  if (threadRaw != null) {
    const threadId = Number(threadRaw);
    if (!Number.isFinite(threadId) || !Number.isInteger(threadId) || threadId < 0) {
      return fail("config.threadId must be a non-negative integer");
    }
    clean.threadId = threadId;
  }
  if (config.parseMode != null) {
    const mode = String(config.parseMode).trim();
    if (mode && !TELEGRAM_PARSE_MODES.has(mode)) {
      return fail(`config.parseMode must be one of: ${[...TELEGRAM_PARSE_MODES].join(", ")}`);
    }
    if (mode) clean.parseMode = mode;
  }
  return { ok: true, value: { type: "telegram", config: clean } };
}

// Build the audit/API-safe summary for a stored endpoint. The summary is
// stable, readable, and free of bearer tokens / header values / sensitive URL
// query params. Callers fall back to polling for actual results; the summary
// exists only so they can confirm what they registered.
export function summarizeResponseEndpointConfig(type, config = {}) {
  if (type === "http") return summarizeHttpConfig(config);
  if (type === "telegram") return summarizeTelegramConfig(config);
  return { type };
}

function summarizeHttpConfig(config) {
  const rawUrl = String(config.url || "");
  let safeUrl = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (URL_REDACT_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    // Strip the username/password from the URL — those are credentials.
    parsed.username = "";
    parsed.password = "";
    safeUrl = parsed.toString();
  } catch {
    safeUrl = "[invalid-url]";
  }
  const headerNames = Object.keys(config.headers || {});
  return {
    url: safeUrl,
    method: String(config.method || "POST").toUpperCase(),
    headerCount: headerNames.length,
    headerNames: headerNames.map((name) =>
      SECRET_HEADER_NAMES.has(name.toLowerCase()) ? `${name}:[redacted]` : name
    )
  };
}

function summarizeTelegramConfig(config) {
  const summary = { chatId: String(config.chatId || "") };
  if (config.threadId != null) summary.threadId = Number(config.threadId);
  if (config.parseMode) summary.parseMode = String(config.parseMode);
  return summary;
}

// Outward shape for a stored row: id, type, delivery bookkeeping, and the
// redacted summary. Never exposes raw config.
export function presentRunResponseEndpoint(record) {
  if (!record) return null;
  return {
    id: record.id,
    runId: record.runId,
    type: record.type,
    deliveryStatus: record.deliveryStatus || "pending",
    deliveryAttempts: record.deliveryAttempts || 0,
    lastAttemptAt: record.lastAttemptAt || null,
    deliveredAt: record.deliveredAt || null,
    lastError: record.lastError || null,
    createdAt: record.createdAt,
    summary: summarizeResponseEndpointConfig(record.type, record.config || {})
  };
}

// Convenience for code paths that record an event/audit about a freshly
// registered endpoint and want only the redacted fields. Does NOT include
// delivery bookkeeping (the endpoint was just created).
export function safeResponseEndpointAuditDetail(record) {
  if (!record) return null;
  return {
    id: record.id,
    type: record.type,
    summary: summarizeResponseEndpointConfig(record.type, record.config || {})
  };
}
