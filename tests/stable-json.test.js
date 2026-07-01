import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stableJsonString, stableJsonValue } from "../src/stableJson.js";

describe("stable JSON helpers", () => {
  it("sorts object keys recursively while preserving array order", () => {
    assert.deepEqual(stableJsonValue({
      z: 1,
      a: { b: 2, a: 1 },
      list: [{ y: 2, x: 1 }]
    }), {
      a: { a: 1, b: 2 },
      list: [{ x: 1, y: 2 }],
      z: 1
    });
  });

  it("produces equal strings for equivalent objects with different key order", () => {
    assert.equal(
      stableJsonString({ b: 2, a: { d: 4, c: 3 } }),
      stableJsonString({ a: { c: 3, d: 4 }, b: 2 })
    );
  });
});
