import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { packageVersion } from "../src/packageInfo.js";

describe("package info", () => {
  it("exposes the real package.json version (what the runner registers with)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(packageVersion, pkg.version);
    assert.match(packageVersion, /^\d+\.\d+\.\d+/);
  });
});
