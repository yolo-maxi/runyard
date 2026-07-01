import { actorName } from "./routeActors.js";

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

export function createSecretHandlers({
  deleteSecret,
  listSecretMeta,
  recordAudit,
  secretExists,
  secretsEnabled,
  upsertSecret
} = {}) {
  function requireSecretsEnabled(_req, res, next) {
    if (!secretsEnabled()) {
      const response = secretsDisabledResponse();
      return res.status(response.status).json(response.body);
    }
    next();
  }

  return {
    requireSecretsEnabled,

    listSecrets(_req, res) {
      res.json({ secrets: listSecretMeta(), enabled: true });
    },

    upsertSecret(req, res) {
      const validated = validateSecretUpsert({ key: req.params.key, value: req.body?.value });
      if (!validated.ok) return res.status(validated.status).json(validated.body);
      const { key, value } = validated;
      const created = !secretExists(key);
      const meta = upsertSecret({
        key,
        value,
        description: String(req.body?.description || ""),
        createdBy: actorName(req.token)
      });
      // Audit records the key + actor only; secret values never leave storage.
      recordAudit(actorName(req.token), created ? "secret.created" : "secret.updated", key, { key });
      res.status(created ? 201 : 200).json({ secret: meta });
    },

    deleteSecret(req, res) {
      const key = String(req.params.key || "").trim();
      if (!secretExists(key)) return res.status(404).json({ error: "secret not found" });
      deleteSecret(key);
      recordAudit(actorName(req.token), "secret.deleted", key, { key });
      res.json({ ok: true, key });
    }
  };
}
