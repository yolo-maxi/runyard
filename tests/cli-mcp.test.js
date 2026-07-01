import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createJsonApiClient } from "./http-client.js";

const execFileAsync = promisify(execFile);

const temp = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-cli-mcp-"));
process.env.SMITHERS_HUB_ROOT = process.cwd();
process.env.SMITHERS_HUB_DATA_DIR = temp;
process.env.SMITHERS_HUB_DB = path.join(temp, "test.sqlite");
process.env.SMITHERS_HUB_SESSION_SECRET = "test-secret";
process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN = "shub_cli_mcp_token";
process.env.SMITHERS_OBSTRUCTION_ANALYSIS_ENABLED = "0";

const { app } = await import("../src/server.js");

let server;
let baseUrl;
const token = "shub_cli_mcp_token";
const api = createJsonApiClient({ baseUrl: () => baseUrl, token });

function parseToolText(response) {
  const text = response?.result?.content?.[0]?.text || "";
  return JSON.parse(text);
}

function startMcp() {
  const child = spawn(process.execPath, ["src/mcp.js"], {
    cwd: process.cwd(),
    env: { ...process.env, SMITHERS_HUB_URL: baseUrl, SMITHERS_HUB_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let nextId = 0;
  let buffer = "";
  let stderr = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`));
        }, 5000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    stop() {
      child.kill();
    }
  };
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("CLI/MCP discovery and execution intent", () => {
  it("serves a menu and routes local vs remote runs to matching runner locations", async () => {
    const menu = await api("/api/menu");
    assert.equal(menu.hub.sourceOfTruth, true);
    assert.ok(menu.tools.includes("get_menu"));
    assert.ok(menu.executionModes.find((mode) => mode.id === "local"));
    assert.ok(menu.executionModes.find((mode) => mode.id === "remote"));

    const local = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { topic: "local route" },
        executionMode: "local",
        origin: { type: "api-test", label: "API local/remote test" }
      }
    });
    const remote = await api("/api/capabilities/hello/run", {
      method: "POST",
      body: {
        input: { topic: "remote route" },
        executionMode: "remote",
        origin: { type: "api-test", label: "API local/remote test" }
      }
    });

    assert.equal(local.run.execution.mode, "local");
    assert.equal(local.run.execution.runnerLocation, "local");
    assert.equal(local.run.input.__execution.sourceOfTruth, "hub");
    assert.equal(local.outputsLocation, "hub");
    assert.equal(remote.run.execution.mode, "remote");
    assert.equal(remote.run.execution.runnerLocation, "vps");

    const localRunner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "local runner", hostname: "local", tags: ["smithers", "local"] }
    });
    const remoteRunner = await api("/api/runners/register", {
      method: "POST",
      body: { name: "remote runner", hostname: "remote", tags: ["smithers", "vps"] }
    });

    const localClaim = await api(`/api/runners/${localRunner.runner.id}/next-run`);
    const remoteClaim = await api(`/api/runners/${remoteRunner.runner.id}/next-run`);
    assert.equal(localClaim.run.id, local.run.id);
    assert.equal(remoteClaim.run.id, remote.run.id);
  });

  it("CLI menu and run commands preserve Hub execution metadata", async () => {
    const common = ["src/cli.js", "--url", baseUrl, "--token", token, "--json"];
    const menu = await execFileAsync(process.execPath, [...common, "menu"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
    const parsedMenu = JSON.parse(menu.stdout);
    assert.ok(parsedMenu.executionModes.find((mode) => mode.id === "local"));

    const run = await execFileAsync(
      process.execPath,
      [...common, "run", "hello", "--where", "local", "--input", '{"topic":"cli local"}'],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 }
    );
    const parsedRun = JSON.parse(run.stdout);
    assert.equal(parsedRun.run.execution.mode, "local");
    assert.equal(parsedRun.run.execution.runnerLocation, "local");
    assert.equal(parsedRun.run.origin.type, "cli");
    assert.equal(parsedRun.artifactsLocation, "hub");
  });

  it("MCP menu and run_capability expose the same local/remote path", async () => {
    const mcp = startMcp();
    try {
      const init = await mcp.call("initialize", { protocolVersion: "2024-11-05" });
      assert.equal(init.result.serverInfo.name, "runyard-mcp");

      const listed = await mcp.call("tools/list");
      assert.ok(listed.result.tools.find((tool) => tool.name === "get_menu"));

      const menu = parseToolText(await mcp.call("tools/call", { name: "get_menu", arguments: {} }));
      assert.equal(menu.hub.sourceOfTruth, true);
      assert.ok(menu.executionModes.find((mode) => mode.id === "remote"));

      const run = parseToolText(await mcp.call("tools/call", {
        name: "run_capability",
        arguments: { id: "hello", input: { topic: "mcp remote" }, executionMode: "remote" }
      }));
      assert.equal(run.run.execution.mode, "remote");
      assert.equal(run.run.execution.runnerLocation, "vps");
      assert.equal(run.run.origin.type, "mcp");
      assert.equal(run.outputsLocation, "hub");
    } finally {
      mcp.stop();
    }
  });
});
