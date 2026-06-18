import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the config module at a throwaway HOME before importing it.
const home = mkdtempSync(path.join(os.tmpdir(), "shub-cfg-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { readConfig, writeConfig, setRemote, resolveRemote, configFile } = await import("../src/config.js");

test("migrates a legacy single-remote config to the remotes shape", () => {
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ url: "https://legacy.example", token: "shub_legacy" }));
  const cfg = readConfig();
  assert.equal(cfg.current, "default");
  assert.equal(cfg.remotes.default.url, "https://legacy.example");
  assert.equal(resolveRemote().token, "shub_legacy");
});

test("supports multiple remotes and switching the current one", () => {
  setRemote("orgA", "https://a.example/", "shub_a");
  setRemote("orgB", "https://b.example", "shub_b");
  // setRemote makes the just-added one current
  assert.equal(resolveRemote().name, "orgB");
  assert.equal(resolveRemote("orgA").url, "https://a.example"); // trailing slash trimmed
  // explicit selection overrides current
  assert.equal(resolveRemote("orgA").token, "shub_a");
  const cfg = readConfig();
  cfg.current = "orgA";
  writeConfig(cfg);
  assert.equal(resolveRemote().name, "orgA");
});

test("returns empty url/token for an unknown remote", () => {
  const r = resolveRemote("does-not-exist");
  assert.equal(r.url, null);
  assert.equal(r.token, null);
});
