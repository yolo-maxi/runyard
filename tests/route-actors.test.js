import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actorName } from "../src/routeActors.js";

describe("route actor helpers", () => {
  it("chooses stable audit labels from request tokens", () => {
    assert.equal(actorName({ name: "Admin", id: "tok_1" }), "Admin");
    assert.equal(actorName({ id: "tok_1" }), "tok_1");
    assert.equal(actorName(null), "");
    assert.equal(actorName(null, "unknown"), "unknown");
  });
});
