import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boundedInteger,
  normalizeMaxRunMinutes,
  parseMaybeJson
} from "../src/dbNormalization.js";

describe("DB normalization helpers", () => {
  it("parses JSON strings while preserving already-normalized values", () => {
    assert.deepEqual(parseMaybeJson('{"ok":true}', {}), { ok: true });
    assert.deepEqual(parseMaybeJson({ ok: true }, {}), { ok: true });
    assert.deepEqual(parseMaybeJson("", { fallback: true }), { fallback: true });
    assert.deepEqual(parseMaybeJson("{bad", []), []);
  });

  it("normalizes optional max-run minutes", () => {
    assert.equal(normalizeMaxRunMinutes("5.9"), 5);
    assert.equal(normalizeMaxRunMinutes(0), null);
    assert.equal(normalizeMaxRunMinutes("bad"), null);
    assert.equal(normalizeMaxRunMinutes(""), null);
  });

  it("bounds integer values with a fallback for non-numeric input", () => {
    assert.equal(boundedInteger("5.9", 10, { min: 1, max: 8 }), 5);
    assert.equal(boundedInteger("-5", 10, { min: 1, max: 8 }), 1);
    assert.equal(boundedInteger("99", 10, { min: 1, max: 8 }), 8);
    assert.equal(boundedInteger("bad", 10, { min: 1, max: 8 }), 10);
  });
});
