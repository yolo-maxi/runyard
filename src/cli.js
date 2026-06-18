#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { HubClient } from "./apiClient.js";

const configDir = path.join(os.homedir(), ".smithers-hub");
const configFile = path.join(configDir, "config.json");

function readConfig() {
  if (!existsSync(configFile)) return {};
  return JSON.parse(readFileSync(configFile, "utf8"));
}

function writeConfig(config) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function client(options = {}) {
  const config = readConfig();
  const baseUrl = options.url || process.env.SMITHERS_HUB_URL || config.url || "http://127.0.0.1:43117";
  const token = options.token || process.env.SMITHERS_HUB_TOKEN || config.token;
  if (!token) throw new Error("No token configured. Run smithers-hub login --url <url> --token <token>.");
  return new HubClient({ baseUrl, token });
}

function print(data, json) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data)) {
    for (const item of data) console.log(`${item.id || item.slug}\t${item.name || item.title || item.status || ""}\t${item.description || item.currentStep || ""}`);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

const program = new Command();
program.name("smithers-hub").description("CLI for Smithers Hub").version("0.1.0");
program.option("--url <url>", "Hub URL").option("--token <token>", "Hub access token").option("--json", "JSON output");

program
  .command("login")
  .option("--url <url>", "Hub URL")
  .option("--token <token>", "Hub access token")
  .description("Store a long-lived Hub token")
  .action(async (opts) => {
    // Accept the flags whether they come before the subcommand (global) or after it (command-level).
    const url = opts.url || program.opts().url;
    const token = opts.token || program.opts().token;
    if (!url || !token) {
      console.error("login requires --url and --token");
      process.exit(1);
    }
    const hub = new HubClient({ baseUrl: url, token });
    await hub.get("/api/me");
    writeConfig({ url: url.replace(/\/$/, ""), token });
    console.log(`Logged in to ${url}`);
  });

program.command("logout").description("Remove local CLI config").action(() => {
  writeConfig({});
  console.log("Logged out");
});

program.command("status").description("Show current Hub identity").action(async () => {
  print(await client(program.opts()).get("/api/me"), program.opts().json);
});

program.command("capabilities").description("List capabilities").option("-q, --query <query>").action(async (opts) => {
  const data = await client(program.opts()).get(`/api/capabilities${opts.query ? `?q=${encodeURIComponent(opts.query)}` : ""}`);
  print(data.capabilities, program.opts().json);
});

program.command("capability <id>").description("Describe a capability").action(async (id) => {
  print(await client(program.opts()).get(`/api/capabilities/${id}`), program.opts().json);
});

program
  .command("run <capability>")
  .description("Run a capability with JSON input")
  .option("-i, --input <json>", "JSON input", "{}")
  .action(async (capability, opts) => {
    const input = JSON.parse(opts.input);
    print(await client(program.opts()).post(`/api/capabilities/${capability}/run`, { input }), program.opts().json);
  });

program.command("runs").description("List runs").option("-s, --status <status>").action(async (opts) => {
  const data = await client(program.opts()).get(`/api/runs${opts.status ? `?status=${encodeURIComponent(opts.status)}` : ""}`);
  print(data.runs, program.opts().json);
});

program.command("run-status <id>").alias("run-detail").description("Show run detail").action(async (id) => {
  print(await client(program.opts()).get(`/api/runs/${id}`), program.opts().json);
});

program.command("logs <id>").description("Print run logs").action(async (id) => {
  const hub = client(program.opts());
  const response = await fetch(`${hub.baseUrl}/api/runs/${id}/logs`, { headers: { authorization: `Bearer ${hub.token}` } });
  console.log(await response.text());
});

program.command("artifacts [runId]").description("List artifacts").action(async (runId) => {
  const path = runId ? `/api/runs/${runId}/artifacts` : "/api/artifacts";
  const data = await client(program.opts()).get(path);
  print(data.artifacts, program.opts().json);
});

program.command("approvals").description("List pending approvals").action(async () => {
  const data = await client(program.opts()).get("/api/approvals?status=pending");
  print(data.approvals, program.opts().json);
});

program.command("approve <id>").description("Approve an approval request").option("-c, --comment <comment>", "").action(async (id, opts) => {
  print(await client(program.opts()).post(`/api/approvals/${id}/approve`, { comment: opts.comment }), program.opts().json);
});

program.command("reject <id>").description("Reject an approval request").option("-c, --comment <comment>", "").action(async (id, opts) => {
  print(await client(program.opts()).post(`/api/approvals/${id}/reject`, { comment: opts.comment }), program.opts().json);
});

program.command("cancel <runId>").description("Cancel a run").option("-r, --reason <reason>", "").action(async (runId, opts) => {
  print(await client(program.opts()).post(`/api/runs/${runId}/cancel`, { reason: opts.reason }), program.opts().json);
});

program.command("agents").description("List agents").action(async () => print((await client(program.opts()).get("/api/agents")).agents, program.opts().json));
program.command("skills").description("List skills").action(async () => print((await client(program.opts()).get("/api/skills")).skills, program.opts().json));
program.command("knowledge").description("List knowledge resources").option("-q, --query <query>").action(async (opts) => {
  const data = await client(program.opts()).get(`/api/knowledge${opts.query ? `?q=${encodeURIComponent(opts.query)}` : ""}`);
  print(data.knowledge, program.opts().json);
});

program
  .command("token-create <name>")
  .description("Create a new access token")
  .option("--scopes <scopes>", "comma-separated scopes", "api,mcp,runner")
  .option("--expires-in-days <days>", "expiry in days (0 = never)", "0")
  .action(async (name, opts) => {
    const scopes = opts.scopes.split(",").map((scope) => scope.trim()).filter(Boolean);
    print(await client(program.opts()).post("/api/tokens", { name, scopes, expiresInDays: Number(opts.expiresInDays || 0) }), true);
  });

program.command("token-list").description("List access tokens (admin)").action(async () => {
  print((await client(program.opts()).get("/api/tokens")).tokens, program.opts().json);
});

program.command("token-revoke <id>").description("Revoke an access token (admin)").action(async (id) => {
  print(await client(program.opts()).delete(`/api/tokens/${id}`), program.opts().json);
});

program.command("audit").description("Show recent audit log (admin)").action(async () => {
  print((await client(program.opts()).get("/api/audit")).audit, program.opts().json);
});

const runnerCommand = program.command("runner").description("Runner commands");
runnerCommand
  .command("register")
  .description("Register this machine as a runner")
  .option("--name <name>", os.hostname())
  .option("--tags <tags>", "linux,macos,node,git,shell,web,smithers")
  .action(async (opts) => {
    const data = await client(program.opts()).post("/api/runners/register", {
      name: opts.name,
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      tags: opts.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
    });
    print(data, program.opts().json);
  });

runnerCommand.command("start").description("Start a foreground runner using the current CLI config").action(() => {
  const config = readConfig();
  const env = {
    ...process.env,
    SMITHERS_HUB_URL: program.opts().url || process.env.SMITHERS_HUB_URL || config.url,
    SMITHERS_HUB_TOKEN: program.opts().token || process.env.SMITHERS_HUB_TOKEN || config.token
  };
  const child = spawn(process.execPath, [new URL("./runner.js", import.meta.url).pathname], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
});

program
  .command("runner-register")
  .description("Register this machine as a runner")
  .option("--name <name>", os.hostname())
  .option("--tags <tags>", "linux,macos,node,git,shell,web,smithers")
  .action(async (opts) => {
    const data = await client(program.opts()).post("/api/runners/register", {
      name: opts.name,
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      tags: opts.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
    });
    print(data, program.opts().json);
  });

program.command("mcp-config").description("Print Claude/Codex MCP server config snippet").action(() => {
  printMcpConfig();
});

const mcpCommand = program.command("mcp").description("MCP commands");
mcpCommand
  .command("install")
  .description("Configure an AI client (Claude Code/Desktop, Codex) to use this Hub")
  .option("--client <client>", "claude-code | claude-desktop | codex", "claude-code")
  .option("--global", "Claude Code: write user-level config instead of a project .mcp.json")
  .action((opts) => installMcp(opts));
mcpCommand.command("config").description("Print the MCP server config snippet").action(() => printMcpConfig());

function mcpServerSpec() {
  const config = readConfig();
  const url = program.opts().url || process.env.SMITHERS_HUB_URL || config.url || "https://hub.repo.box";
  const token = program.opts().token || process.env.SMITHERS_HUB_TOKEN || config.token || "<SMITHERS_HUB_TOKEN>";
  // Reference mcp.js by absolute path via this CLI's own location, so it works regardless of PATH.
  const mcpJs = fileURLToPath(new URL("./mcp.js", import.meta.url));
  return { command: process.execPath, args: [mcpJs], env: { SMITHERS_HUB_URL: url, SMITHERS_HUB_TOKEN: token } };
}

function mergeJsonConfig(file, mutate) {
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      data = {};
    }
  }
  mutate(data);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function claudeDesktopConfigPath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || home, "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

function installMcp(opts) {
  const server = mcpServerSpec();
  const client = opts.client || "claude-code";
  if (client === "claude-code") {
    const file = opts.global ? path.join(os.homedir(), ".claude.json") : path.join(process.cwd(), ".mcp.json");
    mergeJsonConfig(file, (d) => {
      d.mcpServers = d.mcpServers || {};
      d.mcpServers["smithers-hub"] = server;
    });
    console.log(`Configured Claude Code MCP server -> ${file}`);
    console.log(opts.global ? "Restart Claude Code; 'smithers-hub' tools are now available." : "Open Claude Code in this folder; it will load the 'smithers-hub' tools.");
    return;
  }
  if (client === "claude-desktop") {
    const file = claudeDesktopConfigPath();
    mergeJsonConfig(file, (d) => {
      d.mcpServers = d.mcpServers || {};
      d.mcpServers["smithers-hub"] = server;
    });
    console.log(`Configured Claude Desktop MCP server -> ${file}\nRestart Claude Desktop to load 'smithers-hub'.`);
    return;
  }
  if (client === "codex") {
    console.log(`Add this to ~/.codex/config.toml:\n
[mcp_servers.smithers-hub]
command = ${JSON.stringify(server.command)}
args = ${JSON.stringify(server.args)}

[mcp_servers.smithers-hub.env]
SMITHERS_HUB_URL = ${JSON.stringify(server.env.SMITHERS_HUB_URL)}
SMITHERS_HUB_TOKEN = ${JSON.stringify(server.env.SMITHERS_HUB_TOKEN)}`);
    return;
  }
  console.error(`Unknown client '${client}'. Use: claude-code, claude-desktop, or codex.`);
  process.exit(1);
}

function printMcpConfig() {
  const server = mcpServerSpec();
  console.log(JSON.stringify({ mcpServers: { "smithers-hub": server } }, null, 2));
}

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
