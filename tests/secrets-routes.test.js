import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SECRET_VALUE_MAX,
  createSecretHandlers,
  secretsDisabledResponse,
  validateSecretUpsert
} from "../src/secretsRoutes.js";
import { mockResponse as response } from "./response.js";

function req({ body = {}, params = {}, token = { id: "tok_1", name: "Admin" } } = {}) {
  return { body, params, token };
}

function harness({ enabled = true } = {}) {
  const audits = [];
  const secrets = new Map([
    ["EXISTING", { key: "EXISTING", description: "old" }]
  ]);
  const handlers = createSecretHandlers({
    deleteSecret: (key) => secrets.delete(key),
    listSecretMeta: () => Array.from(secrets.values()),
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
    secretExists: (key) => secrets.has(key),
    secretsEnabled: () => enabled,
    upsertSecret: ({ key, description, createdBy }) => {
      const meta = { key, description, createdBy };
      secrets.set(key, meta);
      return meta;
    }
  });
  return { audits, handlers, secrets };
}

describe("secret route helpers", () => {
  it("builds the disabled-store response in one place", () => {
    assert.deepEqual(secretsDisabledResponse(), {
      status: 503,
      body: {
        error: "secrets store disabled",
        message: "Set SECRETS_ENC_KEY (a 32-byte base64/hex key) on the Hub to enable encrypted secrets."
      }
    });
  });

  it("validates env-safe secret keys and required values", () => {
    assert.deepEqual(validateSecretUpsert({ key: "  API_TOKEN  ", value: "secret" }), {
      ok: true,
      key: "API_TOKEN",
      value: "secret"
    });
    assert.equal(validateSecretUpsert({ key: "1BAD", value: "secret" }).status, 400);
    assert.equal(validateSecretUpsert({ key: "BAD-DASH", value: "secret" }).status, 400);
    assert.equal(validateSecretUpsert({ key: "GOOD", value: "" }).body.error, "value is required");
    assert.equal(validateSecretUpsert({ key: "GOOD", value: "x".repeat(SECRET_VALUE_MAX + 1) }).status, 413);
  });

  it("gates every secrets route when encrypted storage is disabled", () => {
    const { handlers } = harness({ enabled: false });
    const res = response();
    let nextCalled = false;

    handlers.requireSecretsEnabled(req(), res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "secrets store disabled");
  });

  it("lists metadata and upserts secrets without returning values", () => {
    const { audits, handlers } = harness();

    const listRes = response();
    handlers.listSecrets(req(), listRes);
    assert.deepEqual(listRes.body, { secrets: [{ key: "EXISTING", description: "old" }], enabled: true });

    const createRes = response();
    handlers.upsertSecret(req({
      params: { key: "API_TOKEN" },
      body: { value: "secret-value", description: "token" }
    }), createRes);
    assert.equal(createRes.statusCode, 201);
    assert.deepEqual(createRes.body.secret, { key: "API_TOKEN", description: "token", createdBy: "Admin" });
    assert.equal(JSON.stringify(createRes.body).includes("secret-value"), false);
    assert.deepEqual(audits[0], {
      actor: "Admin",
      action: "secret.created",
      target: "API_TOKEN",
      detail: { key: "API_TOKEN" }
    });

    const updateRes = response();
    handlers.upsertSecret(req({
      params: { key: "API_TOKEN" },
      token: { id: "tok_fallback" },
      body: { value: "next-value" }
    }), updateRes);
    assert.equal(updateRes.statusCode, 200);
    assert.equal(audits[1].action, "secret.updated");
    assert.equal(audits[1].actor, "tok_fallback");
  });

  it("deletes existing secrets and 404s missing ones", () => {
    const { audits, handlers, secrets } = harness();

    const missingRes = response();
    handlers.deleteSecret(req({ params: { key: "MISSING" } }), missingRes);
    assert.equal(missingRes.statusCode, 404);

    const deleteRes = response();
    handlers.deleteSecret(req({ params: { key: " EXISTING " } }), deleteRes);
    assert.deepEqual(deleteRes.body, { ok: true, key: "EXISTING" });
    assert.equal(secrets.has("EXISTING"), false);
    assert.equal(audits[0].action, "secret.deleted");
  });
});
