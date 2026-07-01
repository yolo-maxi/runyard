import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import {
  defaultDbPath,
  deriveEnvironmentLabel,
  deriveHostnameLabel,
  DEV_SESSION_SECRET,
  firstEnv,
  resolveSessionSecret
} from "../src/envConfig.js";

describe("env config helpers", () => {
  it("reads the first non-empty environment alias", () => {
    assert.equal(firstEnv({ A: "", B: "two", C: "three" }, "A", "B", "C"), "two");
    assert.equal(firstEnv({ A: "" }, "A", "B"), undefined);
  });

  it("selects the safest default DB path across canonical and legacy files", () => {
    const dir = "/data";
    const runyard = path.join(dir, "runyard.sqlite");
    const legacy = path.join(dir, "smithers-hub.sqlite");
    assert.equal(defaultDbPath(dir, { exists: () => false }), runyard);
    assert.equal(defaultDbPath(dir, { exists: (file) => file === legacy }), legacy);
    assert.equal(defaultDbPath(dir, {
      exists: () => true,
      stat: (file) => ({ size: file === legacy ? 100 : 10 })
    }), legacy);
    assert.equal(defaultDbPath(dir, {
      exists: () => true,
      stat: (file) => ({ size: file === legacy ? 10 : 100 })
    }), runyard);
  });

  it("derives environment and hostname labels from explicit config or URL", () => {
    assert.equal(deriveEnvironmentLabel({ env: { RUNYARD_HUB_ENV: "STAGING" }, baseUrl: "https://prod.example", isProduction: true }), "staging");
    assert.equal(deriveEnvironmentLabel({ env: {}, baseUrl: "http://127.0.0.1:43117", isProduction: false }), "local");
    assert.equal(deriveEnvironmentLabel({ env: {}, baseUrl: "https://stage.example.com", isProduction: true }), "staging");
    assert.equal(deriveEnvironmentLabel({ env: {}, baseUrl: "https://dev.example.com", isProduction: true }), "dev");
    assert.equal(deriveEnvironmentLabel({ env: {}, baseUrl: "https://runyard.example.com", isProduction: true }), "prod");

    assert.equal(deriveHostnameLabel({ env: { RUNYARD_HUB_HOSTNAME: "box-1" }, baseUrl: "https://runyard.example.com" }), "box-1");
    assert.equal(deriveHostnameLabel({ env: {}, baseUrl: "https://runyard.example.com" }), "runyard.example.com");
    assert.equal(deriveHostnameLabel({ env: {}, baseUrl: "http://127.0.0.1:43117", hostname: () => "localbox" }), "localbox");
  });

  it("resolves provided, persisted, and generated session secrets", () => {
    assert.equal(resolveSessionSecret({
      env: { RUNYARD_HUB_SESSION_SECRET: "provided" },
      dataDir: "/data",
      isProduction: false
    }), "provided");

    const file = path.join("/data", "session-secret.txt");
    assert.equal(resolveSessionSecret({
      env: {},
      dataDir: "/data",
      isProduction: true,
      exists: (candidate) => candidate === file,
      readFile: () => "persisted\n"
    }), "persisted");

    const writes = [];
    assert.equal(resolveSessionSecret({
      env: {},
      dataDir: "/data",
      isProduction: false,
      exists: () => false,
      writeFile: (target, content, opts) => writes.push({ target, content, opts }),
      chmod: () => {},
      random: () => "generated"
    }), "generated");
    assert.deepEqual(writes, [{ target: file, content: "generated\n", opts: { mode: 0o600 } }]);
  });

  it("rejects the development session secret in production", () => {
    assert.throws(
      () => resolveSessionSecret({
        env: { RUNYARD_HUB_SESSION_SECRET: DEV_SESSION_SECRET },
        dataDir: "/data",
        isProduction: true
      }),
      /insecure development default/
    );
  });
});
