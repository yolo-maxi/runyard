import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_HUB_URL, resolveHubUrl, resolveHubToken } from "../src/hubConnection.js";

describe("hub connection resolution", () => {
  it("resolves the url through the canonical fallback chain", () => {
    assert.equal(resolveHubUrl({ env: {} }), DEFAULT_HUB_URL);
    assert.equal(resolveHubUrl({ env: { HUB_URL: "http://c" } }), "http://c");
    assert.equal(resolveHubUrl({ env: { SMITHERS_HUB_URL: "http://b", HUB_URL: "http://c" } }), "http://b");
    assert.equal(
      resolveHubUrl({ env: { RUNYARD_HUB_URL: "http://a", SMITHERS_HUB_URL: "http://b" } }),
      "http://a"
    );
  });

  it("prefers an explicit url, then env, then the saved remote", () => {
    const env = { RUNYARD_HUB_URL: "http://env" };
    const remote = { url: "http://remote" };
    assert.equal(resolveHubUrl({ explicit: "http://flag", env, remote }), "http://flag");
    assert.equal(resolveHubUrl({ env, remote }), "http://env");
    assert.equal(resolveHubUrl({ env: {}, remote }), "http://remote");
  });

  it("strips a trailing slash from the resolved url", () => {
    assert.equal(resolveHubUrl({ env: { RUNYARD_HUB_URL: "http://a/" } }), "http://a");
  });

  it("resolves the token through the canonical fallback chain", () => {
    assert.equal(resolveHubToken({ env: {} }), "");
    assert.equal(resolveHubToken({ env: { HUB_TOKEN: "c" } }), "c");
    assert.equal(resolveHubToken({ env: { SMITHERS_HUB_TOKEN: "b", HUB_TOKEN: "c" } }), "b");
    assert.equal(resolveHubToken({ env: { RUNYARD_HUB_TOKEN: "a", SMITHERS_HUB_TOKEN: "b" } }), "a");
    assert.equal(resolveHubToken({ explicit: "flag", env: { RUNYARD_HUB_TOKEN: "a" } }), "flag");
    assert.equal(resolveHubToken({ env: {}, remote: { token: "saved" } }), "saved");
  });

  it("only honors the bootstrap token when explicitly allowed", () => {
    const env = { RUNYARD_HUB_BOOTSTRAP_TOKEN: "boot" };
    assert.equal(resolveHubToken({ env }), "");
    assert.equal(resolveHubToken({ env, allowBootstrap: true }), "boot");
    assert.equal(
      resolveHubToken({ env: { SMITHERS_HUB_BOOTSTRAP_TOKEN: "legacy-boot" }, allowBootstrap: true }),
      "legacy-boot"
    );
    // A real token always beats the bootstrap fallback.
    assert.equal(resolveHubToken({ env: { ...env, HUB_TOKEN: "real" }, allowBootstrap: true }), "real");
  });

  it("no src module hardcodes a production hostname as a default", () => {
    // Regression guard: supportWarm.js used to default its hub URL to the
    // production host, so an unconfigured runner silently talked to prod.
    const srcDir = new URL("../src", import.meta.url).pathname;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && readFileSync(full, "utf8").includes("repo.box")) offenders.push(full);
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, []);
  });
});
