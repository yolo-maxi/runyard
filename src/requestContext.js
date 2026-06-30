import { slugify } from "./ids.js";
import { normalizeOrigin } from "./presentation.js";

export function tokenRequestVia(token = {}) {
  const scopes = token.scopes || [];
  if (scopes.includes("mcp") && !scopes.includes("api")) return "mcp";
  if (scopes.includes("runner") && !scopes.includes("api")) return "runner";
  return "token";
}

export function bearerFromRequest(req) {
  const header = req?.headers?.authorization || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

export function requestOrigin(req, input = {}) {
  const token = req.token || {};
  const scopes = token.scopes || [];
  const via = tokenRequestVia(token);
  const explicit = normalizeOrigin(req.body?.origin) || normalizeOrigin(input?.origin) || normalizeOrigin(input?.source) || normalizeOrigin(input?.context?.origin);
  const headerOrigin = normalizeOrigin({
    label: req.headers["x-smithers-origin"] || "",
    url: req.headers["x-smithers-origin-url"] || "",
    chat: req.headers["x-smithers-origin-chat"] || "",
    thread: req.headers["x-smithers-origin-thread"] || "",
    messageId: req.headers["x-smithers-origin-message-id"] || ""
  });
  return {
    requestedBy: `${via}: ${token.name || token.id || "unknown"}`,
    origin: {
      label: `${via}: ${token.name || token.id || "unknown"}`,
      type: via,
      name: token.name || "",
      scopes,
      ...(headerOrigin || {}),
      ...(explicit || {})
    }
  };
}

export function requireBodySlug(body = {}, fallback) {
  return body.slug || slugify(body.name || body.title || fallback);
}
