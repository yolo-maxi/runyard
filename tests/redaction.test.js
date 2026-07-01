import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRedactionRules,
  redactText,
  truncateText
} from "../src/redaction.js";

describe("shared redaction helpers", () => {
  it("redacts common token and API-key shapes", () => {
    const text = applyRedactionRules("authorization: Bearer shub_abc123456789 and x-api-key=sk-abc123def456ghi789");
    assert.doesNotMatch(text, /shub_abc123456789/);
    assert.doesNotMatch(text, /sk-abc123def456/);
    assert.match(text, /\[redacted\]/);
  });

  it("covers bearer tokens, GitHub token variants, JWTs, and private keys", () => {
    const text = applyRedactionRules([
      "Bearer abcdefghijk",
      "refresh_token=secret-refresh-value",
      "gho_abcdefghijklmnopqrstuvwxyz",
      "eyJabcdefghi.payload.signature",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"
    ].join("\n"));
    assert.doesNotMatch(text, /abcdefghijk/);
    assert.doesNotMatch(text, /secret-refresh-value/);
    assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(text, /eyJabcdefghi/);
    assert.doesNotMatch(text, /BEGIN PRIVATE KEY/);
    assert.match(text, /Bearer \[redacted\]/);
    assert.match(text, /gh_\[redacted\]/);
    assert.match(text, /\[redacted-jwt\]/);
    assert.match(text, /\[redacted-private-key\]/);
  });

  it("supports caller-specific truncation style", () => {
    assert.equal(truncateText("alpha beta gamma", 12, { wordBoundary: true }), "alpha beta…");
    assert.equal(truncateText("alpha   beta gamma", 10, { collapseWhitespace: true }), "alpha bet…");
  });

  it("combines redaction and truncation", () => {
    const text = redactText("token=shub_abc123456789 and trailing text", { max: 22, wordBoundary: true });
    assert.doesNotMatch(text, /shub_abc/);
    assert.match(text, /\[redacted\]/);
    assert.ok(text.length <= 22);
  });
});
