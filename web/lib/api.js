// Centralized fetch wrapper for the Hub API. Ported 1:1 from the legacy
// public/app.js `api()` so the HTTP/auth contract is unchanged: relative URLs,
// JSON in/out, cookie-based session (the browser attaches `shub_session`
// automatically — the client stores no token), and a thrown Error carrying the
// server's `error` field on any non-2xx response.

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function api(path, options = {}) {
  const init = { ...options };
  init.headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text; // plain-text endpoints (logs, llms.txt) come back as strings
    }
  }
  if (!response.ok) {
    const message = (data && data.error) || `HTTP ${response.status}`;
    throw new ApiError(message, response.status, data);
  }
  return data;
}

// Convenience helpers mirroring app.js call sites.
export const apiGet = (path) => api(path);
export const apiPost = (path, body) => api(path, { method: "POST", body });
export const apiPut = (path, body) => api(path, { method: "PUT", body });
export const apiPatch = (path, body) => api(path, { method: "PATCH", body });
export const apiDelete = (path) => api(path, { method: "DELETE" });

// Builds a querystring from a params object, skipping null/undefined/"".
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
