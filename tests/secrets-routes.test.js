import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SECRET_VALUE_MAX,
  actorName,
  secretsDisabledResponse,
  validateSecretUpsert
} from "../src/secretsRoutes.js";

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

  it("chooses the best actor label for secret metadata", () => {
    assert.equal(actorName({ name: "Admin", id: "tok_1" }), "Admin");
    assert.equal(actorName({ id: "tok_1" }), "tok_1");
    assert.equal(actorName(null), "");
  });
});
