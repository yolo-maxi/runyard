import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claudeDesktopConfigPath,
  mcpJsonEntry,
  mcpServerName,
  mcpServerSpec,
  mergeMcpJsonConfig,
  upsertMcpTomlServer,
  vscodeMcpJsonEntry
} from "../src/cliMcpConfig.js";

describe("CLI MCP config helpers", () => {
  it("builds stable server names and stdio specs without storing tokens", () => {
    const resolveRemote = (name) => ({ name: name || "default" });
    assert.equal(mcpServerName("default"), "runyard");
    assert.equal(mcpServerName("acme"), "runyard-acme");
    assert.deepEqual(mcpServerSpec("acme", { resolveRemote, mcpJs: "/app/src/mcp.js", nodePath: "/node" }), {
      command: "/node",
      args: ["/app/src/mcp.js", "--remote", "acme"]
    });
  });

  it("merges JSON MCP configs without removing unrelated keys or servers", () => {
    const server = { command: "/node", args: ["/mcp.js", "--remote", "default"] };
    const merged = mergeMcpJsonConfig({ theme: "dark", mcpServers: { other: { command: "x" } } }, "runyard", server);
    assert.equal(merged.theme, "dark");
    assert.deepEqual(merged.mcpServers.other, { command: "x" });
    assert.deepEqual(merged.mcpServers.runyard, mcpJsonEntry(server));

    const vscode = mergeMcpJsonConfig({}, "runyard", server, { key: "servers", entry: vscodeMcpJsonEntry });
    assert.deepEqual(vscode.servers.runyard, { type: "stdio", command: "/node", args: ["/mcp.js", "--remote", "default"] });
  });

  it("upserts Codex TOML server blocks idempotently", () => {
    const server = { command: "/node", args: ["/mcp.js", "--remote", "default"] };
    const first = upsertMcpTomlServer("[profile]\nname = \"default\"\n", "runyard", server);
    assert.match(first, /\[profile\]/);
    assert.match(first, /\[mcp_servers\.runyard\]/);
    assert.match(first, /args = \["\/mcp\.js","--remote","default"\]/);

    const second = upsertMcpTomlServer(first, "runyard", { command: "/node2", args: ["/mcp2.js"] });
    assert.equal((second.match(/\[mcp_servers\.runyard\]/g) || []).length, 1);
    assert.match(second, /command = "\/node2"/);
    assert.doesNotMatch(second, /command = "\/node"/);
  });

  it("resolves Claude Desktop config paths per platform", () => {
    assert.equal(
      claudeDesktopConfigPath({ home: "/Users/me", platform: "darwin" }),
      "/Users/me/Library/Application Support/Claude/claude_desktop_config.json"
    );
    assert.equal(
      claudeDesktopConfigPath({ home: "C:\\Users\\me", platform: "win32", appData: "C:\\Users\\me\\AppData\\Roaming" }),
      "C:\\Users\\me\\AppData\\Roaming/Claude/claude_desktop_config.json"
    );
    assert.equal(
      claudeDesktopConfigPath({ home: "/home/me", platform: "linux" }),
      "/home/me/.config/Claude/claude_desktop_config.json"
    );
  });
});
