import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMcpClientRegistry,
  installMcpClients,
  mcpConfigSnippet,
  mergeJsonFile,
  upsertTomlFile
} from "../src/cliMcpInstall.js";

function remoteResolver(name = "default") {
  return { name: name || "default" };
}

describe("CLI MCP installer helpers", () => {
  it("merges JSON and TOML config files through injected IO", () => {
    const jsonWrites = [];
    mergeJsonFile("/cfg/mcp.json", (data) => {
      data.mcpServers = { runyard: { command: "node" } };
    }, {
      mkdir: () => {},
      readJson: () => ({ theme: "dark" }),
      writeJson: (file, data) => jsonWrites.push({ file, data })
    });
    assert.deepEqual(jsonWrites, [{
      file: "/cfg/mcp.json",
      data: { theme: "dark", mcpServers: { runyard: { command: "node" } } }
    }]);

    const tomlWrites = [];
    upsertTomlFile("/cfg/config.toml", "runyard", { command: "node", args: ["mcp.js"] }, {
      exists: () => true,
      mkdir: () => {},
      readFile: () => "[profile]\nname = \"default\"\n",
      writeFile: (file, content) => tomlWrites.push({ file, content })
    });
    assert.match(tomlWrites[0].content, /\[mcp_servers\.runyard\]/);
  });

  it("builds detected client registry entries with stable target files", () => {
    const writes = [];
    const registry = createMcpClientRegistry({
      home: "/home/me",
      cwd: "/repo",
      exists: (file) => file === "/home/me/.codex" || file === "/repo/.vscode",
      io: {
        mkdir: () => {},
        readJson: () => ({}),
        writeJson: (file, data) => writes.push({ file, data }),
        exists: () => false,
        writeFile: (file, content) => writes.push({ file, content })
      }
    });

    assert.equal(registry.codex.detect(), true);
    assert.equal(registry.vscode.detect(), true);
    assert.equal(registry["claude-code"].detect(), false);
    assert.equal(registry.vscode.apply("runyard", { command: "node", args: ["mcp.js"] }, {}), "/repo/.vscode/mcp.json");
    assert.deepEqual(writes[0].data.servers.runyard, { type: "stdio", command: "node", args: ["mcp.js"] });
  });

  it("installs requested clients and reports unknown clients without writing tokens", () => {
    const logs = [];
    const applied = [];
    const clients = {
      codex: {
        detect: () => true,
        apply: (name, server) => {
          applied.push({ name, server });
          return "/home/me/.codex/config.toml";
        },
        activate: "restart"
      }
    };

    const result = installMcpClients({ client: "codex", remote: "acme" }, {
      currentRemote: "default",
      resolveRemote: remoteResolver,
      mcpJs: "/repo/src/mcp.js",
      clients,
      log: (line) => logs.push(line)
    });

    assert.equal(result.remote, "acme");
    assert.equal(result.installed[0].id, "codex");
    assert.equal(applied[0].name, "runyard-acme");
    assert.deepEqual(applied[0].server.args, ["/repo/src/mcp.js", "--remote", "acme"]);
    assert.ok(logs.at(-1).includes("none is stored"));

    const failures = [];
    installMcpClients({ client: "missing" }, {
      currentRemote: "default",
      resolveRemote: remoteResolver,
      mcpJs: "/repo/src/mcp.js",
      clients,
      log: () => {},
      fail: (message) => failures.push(message)
    });
    assert.match(failures[0], /Unknown client/);
  });

  it("prints MCP config snippets without token material", () => {
    assert.deepEqual(mcpConfigSnippet({
      remoteName: "acme",
      resolveRemote: remoteResolver,
      mcpJs: "/repo/src/mcp.js"
    }), {
      mcpServers: {
        "runyard-acme": {
          command: process.execPath,
          args: ["/repo/src/mcp.js", "--remote", "acme"]
        }
      }
    });
  });
});
