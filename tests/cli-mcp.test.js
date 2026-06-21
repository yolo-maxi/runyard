import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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

function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  });
}

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
      assert.equal(init.result.serverInfo.name, "smithers-hub-mcp");

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

  it("menu declares capabilities as the public contract and lists the compatibility aliases", async () => {
    const menu = await api("/api/menu");
    assert.equal(menu.publicContract?.unit, "capability");
    assert.equal(menu.publicContract?.preferOverLocalWorkflowMcp, true);
    assert.equal(menu.publicContract?.compatibilityAliases?.list_workflows, "list_capabilities");
    assert.equal(menu.publicContract?.compatibilityAliases?.run_workflow, "run_capability");
    assert.ok(menu.tools.includes("list_capabilities"));
    assert.ok(menu.tools.includes("search_capabilities"));
    assert.ok(menu.tools.includes("list_runs"));
    assert.ok(menu.tools.includes("list_workflows"));
    assert.ok(menu.tools.includes("run_workflow"));
    assert.ok(menu.tools.includes("watch_run"));
    assert.ok(menu.install?.mcporter?.includes("mcporter"));
    assert.ok(menu.install?.replaceLocalSmithers?.includes("--as smithers"));
    // The discovery entries must explicitly point a 'do X' request at
    // search_capabilities before bespoke work — without this hint, agents
    // landed on get_menu still skip the catalog.
    const doX = menu.discovery?.find((entry) => entry.surface === "do-X");
    assert.ok(doX, "menu.discovery must include a 'do-X' entry");
    assert.match(doX.action, /search_capabilities/);
  });

  it("menu advertises every MCP tool that src/mcp.js exposes", async () => {
    const menu = await api("/api/menu");
    const mcp = startMcp();
    try {
      await mcp.call("initialize", { protocolVersion: "2024-11-05" });
      const listed = await mcp.call("tools/list");
      const toolNames = listed.result.tools.map((tool) => tool.name).sort();
      const menuTools = [...menu.tools].sort();
      assert.deepEqual(
        menuTools,
        toolNames,
        "/api/menu.tools must mirror the MCP tools/list exactly so /llms.txt and get_menu don't drift from the live server"
      );
    } finally {
      mcp.stop();
    }
  });

  it("MCP exposes the full capability-first toolset and the smithers-orchestrator compatibility aliases", async () => {
    const mcp = startMcp();
    try {
      await mcp.call("initialize", { protocolVersion: "2024-11-05" });
      const listed = await mcp.call("tools/list");
      const toolNames = listed.result.tools.map((tool) => tool.name);
      for (const required of [
        "list_capabilities",
        "search_capabilities",
        "describe_capability",
        "run_capability",
        "list_runs",
        "get_run_status",
        "list_runners",
        // compatibility aliases
        "list_workflows",
        "run_workflow",
        "watch_run"
      ]) {
        assert.ok(toolNames.includes(required), `tool ${required} missing from MCP tools/list`);
      }

      const aliasList = parseToolText(await mcp.call("tools/call", { name: "list_workflows", arguments: {} }));
      const direct = parseToolText(await mcp.call("tools/call", { name: "list_capabilities", arguments: {} }));
      assert.deepEqual(
        aliasList.capabilities.map((cap) => cap.slug).sort(),
        direct.capabilities.map((cap) => cap.slug).sort()
      );

      const aliasRun = parseToolText(await mcp.call("tools/call", {
        name: "run_workflow",
        arguments: { workflowId: "hello", prompt: "alias-run", executionMode: "local" }
      }));
      assert.equal(aliasRun.run.capabilitySlug, "hello");
      assert.equal(aliasRun.run.execution.mode, "local");
      assert.equal(aliasRun.run.input.prompt, "alias-run");

      const watched = parseToolText(await mcp.call("tools/call", {
        name: "watch_run",
        arguments: { runId: aliasRun.run.id }
      }));
      assert.equal(watched.run.id, aliasRun.run.id);
    } finally {
      mcp.stop();
    }
  });

  it("mcp-config prints the Hub MCP spec (not the smithers-orchestrator workflow MCP) and supports --as for aliasing", async () => {
    const common = ["src/cli.js", "--url", baseUrl, "--token", token];
    const jsonOut = await execFileAsync(process.execPath, [...common, "--json", "mcp-config"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(jsonOut.stdout);
    const [serverName] = Object.keys(parsed.mcpServers);
    assert.equal(serverName, "smithers-hub");
    const spec = parsed.mcpServers[serverName];
    assert.ok(spec.args.some((arg) => arg.endsWith("src/mcp.js")), "config must point at the Hub MCP entry, not the local smithers-orchestrator MCP");
    assert.ok(!spec.args.some((arg) => /smithers-orchestrator/.test(arg)));

    const aliasOut = await execFileAsync(process.execPath, [...common, "mcp-config", "--as", "smithers"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
    const aliasJson = aliasOut.stdout.split(/\n\n/, 1)[0];
    const aliasParsed = JSON.parse(aliasJson);
    assert.ok(aliasParsed.mcpServers.smithers, "--as smithers should register the Hub MCP under the smithers name");
    assert.ok(aliasOut.stdout.includes("mcporter"), "footer should mention the OpenClaw/mcporter install path");
  });

  it("mcp install --client mcporter writes a Hub MCP entry to ~/.mcporter/mcporter.json (and overrides `smithers` with --as smithers)", async () => {
    // Isolate HOME so the test never touches the real ~/.mcporter or
    // ~/.smithers-hub. The CLI resolves the remote from ~/.smithers-hub, so
    // we plant a config.json that points at the in-process test Hub.
    const home = mkdtempSync(path.join(os.tmpdir(), "smithers-hub-mcporter-home-"));
    mkdirSync(path.join(home, ".smithers-hub"), { recursive: true });
    writeFileSync(
      path.join(home, ".smithers-hub", "config.json"),
      JSON.stringify({ version: 2, current: "default", remotes: { default: { url: baseUrl, token } } })
    );
    // Seed an existing local smithers-orchestrator entry so we can confirm
    // --as smithers replaces it (the override path) without dropping the
    // sibling smithers-hub entry from the file.
    mkdirSync(path.join(home, ".mcporter"), { recursive: true });
    const mcporterFile = path.join(home, ".mcporter", "mcporter.json");
    writeFileSync(
      mcporterFile,
      JSON.stringify({ mcpServers: { smithers: { command: "smithers", args: ["mcp"] } } })
    );

    const childEnv = { ...process.env, HOME: home, USERPROFILE: home, SMITHERS_HUB_URL: "", SMITHERS_HUB_TOKEN: "" };

    await execFileAsync(
      process.execPath,
      ["src/cli.js", "mcp", "install", "--client", "mcporter"],
      { cwd: process.cwd(), env: childEnv, maxBuffer: 1024 * 1024 }
    );
    const afterDefault = JSON.parse(readFileSync(mcporterFile, "utf8"));
    assert.ok(afterDefault.mcpServers["smithers-hub"], "default install must register `smithers-hub` server name");
    assert.equal(afterDefault.mcpServers["smithers-hub"].command, process.execPath);
    assert.ok(
      afterDefault.mcpServers["smithers-hub"].args.some((arg) => arg.endsWith("src/mcp.js")),
      "default install must launch the Hub MCP entry (src/mcp.js)"
    );
    assert.ok(afterDefault.mcpServers.smithers, "default install must leave a pre-existing `smithers` entry untouched");

    await execFileAsync(
      process.execPath,
      ["src/cli.js", "mcp", "install", "--client", "mcporter", "--as", "smithers"],
      { cwd: process.cwd(), env: childEnv, maxBuffer: 1024 * 1024 }
    );
    const afterOverride = JSON.parse(readFileSync(mcporterFile, "utf8"));
    assert.ok(
      afterOverride.mcpServers.smithers.args.some((arg) => arg.endsWith("src/mcp.js")),
      "--as smithers must overwrite the smithers entry with the Hub MCP"
    );
    assert.ok(afterOverride.mcpServers["smithers-hub"], "the previous smithers-hub entry must remain so sessions keyed off either name still land on the Hub");
  });
});
