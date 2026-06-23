import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const { encrypt, decrypt, redactSecrets, secretsEnabled, loadSecretsKey } = await import("../src/secretsStore.js");

const hexKey = randomBytes(32).toString("hex");
const b64Key = randomBytes(32).toString("base64");

describe("secretsStore crypto", () => {
  it("round-trips a value through encrypt/decrypt", () => {
    const blob = encrypt("hunter2-super-secret", hexKey);
    assert.ok(Buffer.isBuffer(blob));
    // Ciphertext must not contain the plaintext.
    assert.ok(!blob.toString("utf8").includes("hunter2"));
    assert.equal(decrypt(blob, hexKey), "hunter2-super-secret");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encrypt("same-value-here", hexKey);
    const b = encrypt("same-value-here", hexKey);
    assert.notDeepEqual(a, b);
    assert.equal(decrypt(a, hexKey), "same-value-here");
    assert.equal(decrypt(b, hexKey), "same-value-here");
  });

  it("accepts a base64 key as well as hex", () => {
    const blob = encrypt("via-base64-key", b64Key);
    assert.equal(decrypt(blob, b64Key), "via-base64-key");
    assert.ok(loadSecretsKey(b64Key));
    assert.ok(loadSecretsKey(hexKey));
  });

  it("fails to decrypt with the wrong key (GCM auth)", () => {
    const blob = encrypt("tamper-check", hexKey);
    const otherKey = randomBytes(32).toString("hex");
    assert.throws(() => decrypt(blob, otherKey));
  });

  it("fails to decrypt a tampered ciphertext", () => {
    const blob = encrypt("integrity", hexKey);
    blob[blob.length - 1] ^= 0xff;
    assert.throws(() => decrypt(blob, hexKey));
  });

  it("is disabled (throws) when no/invalid key is configured", () => {
    assert.equal(secretsEnabled(""), false);
    assert.equal(secretsEnabled("too-short"), false);
    assert.equal(loadSecretsKey(""), null);
    assert.throws(() => encrypt("x", ""));
    assert.throws(() => decrypt(Buffer.alloc(40), ""));
  });

  it("enables only with a valid 32-byte key", () => {
    assert.equal(secretsEnabled(hexKey), true);
    assert.equal(secretsEnabled(b64Key), true);
  });
});

describe("secretsStore redaction", () => {
  it("redacts secret values from strings", () => {
    const out = redactSecrets("token is sk-abcdef123456 here", ["sk-abcdef123456"]);
    assert.ok(!out.includes("sk-abcdef123456"));
    assert.ok(out.includes("[redacted:secret]"));
  });

  it("redacts recursively through objects and arrays", () => {
    const secret = "ghp_supersecretvalue";
    const out = redactSecrets(
      { a: secret, nested: { b: [`prefix ${secret} suffix`, "clean"] } },
      [secret]
    );
    assert.ok(!JSON.stringify(out).includes("ghp_supersecretvalue"));
    assert.equal(out.nested.b[1], "clean");
  });

  it("ignores very short needles to avoid clobbering incidental text", () => {
    const out = redactSecrets("abc def", ["ab"]);
    assert.equal(out, "abc def");
  });

  it("is a no-op when there are no secret values", () => {
    assert.equal(redactSecrets("nothing to do", []), "nothing to do");
  });
});
