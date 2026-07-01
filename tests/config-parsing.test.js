import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBool, parseRootList, parseTrustProxy, positiveNumber } from "../src/configParsing.js";

describe("config parsing helpers", () => {
  it("parses common boolean env flag spellings", () => {
    assert.equal(parseBool(undefined, false), false);
    assert.equal(parseBool("", true), true);
    assert.equal(parseBool("0", true), false);
    assert.equal(parseBool("false", true), false);
    assert.equal(parseBool("off", true), false);
    assert.equal(parseBool("no", true), false);
    assert.equal(parseBool("1", false), true);
    assert.equal(parseBool("yes", false), true);
  });

  it("keeps only positive finite numbers", () => {
    assert.equal(positiveNumber("25", 10), 25);
    assert.equal(positiveNumber("0", 10), 10);
    assert.equal(positiveNumber("-1", 10), 10);
    assert.equal(positiveNumber("bad", 10), 10);
  });

  it("parses colon/comma separated filesystem root lists", () => {
    const resolve = (entry) => `/resolved/${entry.replace(/^\//, "")}`;
    assert.deepEqual(parseRootList(" /srv/app:/tmp/work, relative ", { resolve }), [
      "/resolved/srv/app",
      "/resolved/tmp/work",
      "/resolved/relative"
    ]);
    assert.deepEqual(parseRootList("", { resolve }), []);
  });

  it("parses Express trust-proxy values", () => {
    assert.equal(parseTrustProxy(undefined), "loopback");
    assert.equal(parseTrustProxy(""), "loopback");
    assert.equal(parseTrustProxy("true"), true);
    assert.equal(parseTrustProxy("false"), false);
    assert.equal(parseTrustProxy("2"), 2);
    assert.equal(parseTrustProxy("10.0.0.0/8"), "10.0.0.0/8");
  });
});
