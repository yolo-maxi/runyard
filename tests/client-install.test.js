import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createCliTarballBuilder, installScript } from "../src/clientInstall.js";

describe("client install helpers", () => {
  it("builds the CLI tarball with optional workflow and commander paths", () => {
    const calls = [];
    const root = "/repo";
    const dataDir = "/data";
    const exists = (file) =>
      file === path.join(root, "workflow-templates")
      || file === path.join(root, "node_modules", "commander");
    const build = createCliTarballBuilder({
      root,
      dataDir,
      exists,
      execFile: (...args) => calls.push(args)
    });

    assert.equal(build(), path.join(dataDir, "cli.tgz"));
    assert.deepEqual(calls, [[
      "tar",
      ["czhf", path.join(dataDir, "cli.tgz"), "-C", root, "bin", "src", "package.json", "workflow-templates", "node_modules/commander"]
    ]]);
  });

  it("reuses an existing tarball path without rebuilding", () => {
    const calls = [];
    const root = "/repo";
    const dataDir = "/data";
    let tarballExists = false;
    const build = createCliTarballBuilder({
      root,
      dataDir,
      exists: (file) => {
        if (file === path.join(dataDir, "cli.tgz")) return tarballExists;
        return false;
      },
      execFile: (...args) => {
        calls.push(args);
        tarballExists = true;
      }
    });

    assert.equal(build(), path.join(dataDir, "cli.tgz"));
    assert.equal(build(), path.join(dataDir, "cli.tgz"));
    assert.equal(calls.length, 1);
  });

  it("renders a one-line installer that honors environment overrides", () => {
    const script = installScript("https://hub.example");

    assert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    assert.ok(script.includes("DEFAULT_HUB_URL='https://hub.example'"));
    assert.ok(script.includes('HUB_URL="${RUNYARD_HUB_URL:-${SMITHERS_HUB_URL:-$DEFAULT_HUB_URL}}"'));
    assert.ok(script.includes('curl -fsSL "$HUB_URL/cli.tgz" -o "$tmp"'));
    assert.ok(script.includes("runyard mcp install --all"));
  });

  it("shell-quotes the default Hub URL in the rendered installer", () => {
    const script = installScript("https://hub.example/'$(touch pwn)'");

    assert.ok(script.includes("DEFAULT_HUB_URL='https://hub.example/'\\''$(touch pwn)'\\'''"));
    assert.doesNotMatch(script, /SMITHERS_HUB_URL:-https:\/\/hub\.example\/'\$\(touch pwn\)'/);
  });
});
