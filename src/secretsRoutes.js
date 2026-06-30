export const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const SECRET_VALUE_MAX = 32 * 1024;

export function secretsDisabledResponse() {
  return {
    status: 503,
    body: {
      error: "secrets store disabled",
      message: "Set SECRETS_ENC_KEY (a 32-byte base64/hex key) on the Hub to enable encrypted secrets."
    }
  };
}

export function validateSecretUpsert({ key, value } = {}) {
  const normalizedKey = String(key || "").trim();
  if (!SECRET_KEY_RE.test(normalizedKey)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid secret key",
        message: "Use an env-var-safe name: letters, digits, underscore; must not start with a digit."
      }
    };
  }
  if (typeof value !== "string" || !value.length) {
    return { ok: false, status: 400, body: { error: "value is required" } };
  }
  if (value.length > SECRET_VALUE_MAX) {
    return { ok: false, status: 413, body: { error: "secret value too large" } };
  }
  return { ok: true, key: normalizedKey, value };
}

export function actorName(token = {}) {
  if (!token || typeof token !== "object") return "";
  return token.name || token.id || "";
}
