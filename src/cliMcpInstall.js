import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeDesktopConfigPath,
  mcpJsonEntry,
  mcpServerName,
  mcpServerSpec,
  mergeMcpJsonConfig,
  upsertMcpTomlServer,
  vscodeMcpJsonEntry
} from "./cliMcpConfig.js";
import { readJsonFileOrEmpty, writePrettyJsonFile } from "./cliJson.js";

export function mergeJsonFile(file, mutate, {
  mkdir = mkdirSync,
  readJson = readJsonFileOrEmpty,
  writeJson = writePrettyJsonFile
} = {}) {
  const data = readJson(file);
  mutate(data);
  mkdir(path.dirname(file), { recursive: true });
  writeJson(file, data);
}

export function upsertTomlFile(file, name, server, {
  exists = existsSync,
  mkdir = mkdirSync,
  readFile = readFileSync,
  writeFile = writeFileSync
} = {}) {
  const content = exists(file) ? readFile(file, "utf8") : "";
  mkdir(path.dirname(file), { recursive: true });
  writeFile(file, upsertMcpTomlServer(content, name, server));
}

function jsonWriter(getFile, key = "mcpServers", entry = mcpJsonEntry, io = {}) {
  return (name, server, opts) => {
    const file = getFile(opts);
    mergeJsonFile(file, (data) => Object.assign(data, mergeMcpJsonConfig(data, name, server, { key, entry })), io);
    return file;
  };
}

export function createMcpClientRegistry({
  home = os.homedir(),
  cwd = process.cwd(),
  exists = existsSync,
  io = {}
} = {}) {
  return {
    "claude-code": {
      detect: () => exists(path.join(home, ".claude.json")) || exists(path.join(home, ".claude")),
      apply: jsonWriter((opts) => (opts.global ? path.join(home, ".claude.json") : path.join(cwd, ".mcp.json")), "mcpServers", mcpJsonEntry, io),
      activate: "type /mcp in a Claude Code session (or reopen Claude Code in this folder) and approve it"
    },
    "claude-desktop": {
      detect: () => exists(path.dirname(claudeDesktopConfigPath({ home }))),
      apply: jsonWriter(() => claudeDesktopConfigPath({ home }), "mcpServers", mcpJsonEntry, io),
      activate: "fully quit Claude Desktop (Cmd/Ctrl+Q — not just close the window) and reopen it"
    },
    cursor: {
      detect: () => exists(path.join(home, ".cursor")),
      apply: jsonWriter(() => path.join(home, ".cursor", "mcp.json"), "mcpServers", mcpJsonEntry, io),
      activate: "Cursor → Settings → MCP → enable 'runyard' (or reload the window)"
    },
    windsurf: {
      detect: () => exists(path.join(home, ".codeium")),
      apply: jsonWriter(() => path.join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers", mcpJsonEntry, io),
      activate: "Windsurf → open Cascade → MCP settings → Refresh (or restart Windsurf)"
    },
    gemini: {
      detect: () => exists(path.join(home, ".gemini")),
      apply: jsonWriter(() => path.join(home, ".gemini", "settings.json"), "mcpServers", mcpJsonEntry, io),
      activate: "start a new Gemini CLI session (run `gemini` again)"
    },
    vscode: {
      detect: () => exists(path.join(cwd, ".vscode")) || exists(path.join(home, ".vscode")),
      apply: jsonWriter(() => path.join(cwd, ".vscode", "mcp.json"), "servers", vscodeMcpJsonEntry, io),
      activate: "VS Code → Command Palette → 'MCP: List Servers' → Start (or reload the window)"
    },
    codex: {
      detect: () => exists(path.join(home, ".codex")),
      apply: (name, server) => {
        const file = path.join(home, ".codex", "config.toml");
        upsertTomlFile(file, name, server, io);
        return file;
      },
      activate: "start a new Codex session (it loads MCP servers on launch)"
    }
  };
}

export function mcpConfigSnippet({ remoteName, resolveRemote, mcpJs }) {
  const name = mcpServerName(remoteName);
  const server = mcpServerSpec(remoteName, { resolveRemote, mcpJs });
  return { mcpServers: { [name]: server } };
}

export function installMcpClients(opts, {
  currentRemote = "default",
  resolveRemote,
  mcpJs,
  clients = createMcpClientRegistry(),
  log = console.log,
  fail = (message) => {
    throw new Error(message);
  }
} = {}) {
  const remote = resolveRemote(opts.remote || currentRemote).name;
  const serverName = mcpServerName(remote);
  const server = mcpServerSpec(remote, { resolveRemote, mcpJs });
  const ids = opts.all
    ? Object.keys(clients).filter((id) => clients[id].detect())
    : [opts.client || "claude-code"];

  if (opts.all && !ids.length) {
    log("No known AI clients detected on this machine. Use --client <name>.");
    return { remote, installed: [] };
  }

  const installed = [];
  for (const id of ids) {
    const client = clients[id];
    if (!client) {
      fail(`Unknown client "${id}". Known: ${Object.keys(clients).join(", ")}`);
      continue;
    }
    const file = client.apply(serverName, server, opts);
    installed.push({ id, file });
    log(`✓ ${id}: wrote "${serverName}" -> ${file}`);
    log(`    to load it: ${client.activate}`);
  }
  log(`\nToken is read from ~/.runyard (remote "${remote}") — none is stored in the configs above.`);
  return { remote, installed };
}
