#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { HubClient } from "./apiClient.js";
import { readConfig, writeConfig, setRemote, resolveRemote } from "./config.js";

function client(options = {}) {
  const remoteName = options.remote || program.opts().remote;
  const remote = resolveRemote(remoteName);
  const baseUrl = options.url || program.opts().url || process.env.SMITHERS_HUB_URL || remote.url || "http://127.0.0.1:43117";
  const token = options.token || program.opts().token || process.env.SMITHERS_HUB_TOKEN || remote.token;
  if (!token) throw new Error("No token configured. Run: smithers-hub login");
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

function ask(query, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => rl.output.write(s === query ? s : "");
    rl.question(query, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const program = new Command();
program.name("smithers-hub").description("CLI for Smithers Hub").version("0.1.0");
program
  .option("--url <url>", "Hub URL")
  .option("--token <token>", "Hub access token")
  .option("--remote <name>", "Org remote to target")
  .option("--json", "JSON output");

program
  .command("login")
  .description("Authenticate to a Hub and save it as a remote (org)")
  .option("--remote <name>", "remote/org name", "default")
  .option("--url <url>", "Hub URL")
  .option("--token <token>", "Hub access token")
  .action(async (opts) => {
    let url = opts.url || program.opts().url;
    let token = opts.token || program.opts().token;
    if (!url) url = await ask("Hub URL: ");
    if (!token) token = await ask("Access token: ", { hidden: true });
    if (!url || !token) {
      console.error("login needs a Hub URL and an access token");
      process.exit(1);
    }
    await new HubClient({ baseUrl: url, token }).get("/api/me");
    setRemote(opts.remote, url, token);
    console.log(`Logged in to ${url} as remote "${opts.remote}".`);
  });

program
  .command("logout")
  .description("Remove a saved remote")
  .option("--all", "remove every remote")
  .action((opts) => {
    if (opts.all) {
      writeConfig({ version: 2, current: "default", remotes: {} });
      console.log("Removed all remotes.");
      return;
    }
    const config = readConfig();
    const name = program.opts().remote || config.current;
    delete config.remotes[name];
    if (config.current === name) config.current = Object.keys(config.remotes)[0] || "default";
    writeConfig(config);
    console.log(`Logged out of "${name}".`);
  });

function listRemotes() {
  const config = readConfig();
  const names = Object.keys(config.remotes);
  if (!names.length) return console.log("No remotes configured. Run: smithers-hub login");
  for (const name of names) console.log(`${name === config.current ? "* " : "  "}${name}\t${config.remotes[name].url}`);
}

program.command("remotes").description("List configured org remotes").action(listRemotes);
const remoteCmd = program.command("remote").description("Manage org remotes");
remoteCmd.command("list").alias("ls").description("List remotes").action(listRemotes);
remoteCmd
  .command("use <name>")
  .description("Switch the current remote")
  .action((name) => {
    const config = readConfig();
    if (!config.remotes[name]) {
      console.error(`No remote "${name}". Run: smithers-hub login --remote ${name}`);
      process.exit(1);
    }
    config.current = name;
    writeConfig(config);
    console.log(`Now using "${name}".`);
  });
remoteCmd
  .command("remove <name>")
  .alias("rm")
  .description("Remove a remote")
  .action((name) => {
    const config = readConfig();
    if (!config.remotes[name]) {
      console.error(`No remote "${name}".`);
      process.exit(1);
    }
    delete config.remotes[name];
    if (config.current === name) config.current = Object.keys(config.remotes)[0] || "default";
    writeConfig(config);
    console.log(`Removed "${name}".`);
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
  const apiPath = runId ? `/api/runs/${runId}/artifacts` : "/api/artifacts";
  const data = await client(program.opts()).get(apiPath);
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

program.command("request-changes <id>").description("Request changes for an approval request").option("-c, --comment <comment>", "").action(async (id, opts) => {
  print(await client(program.opts()).post(`/api/approvals/${id}/request-changes`, { comment: opts.comment }), program.opts().json);
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

function commandExists(cmd) {
  return spawnSync("/usr/bin/env", ["sh", "-c", `command -v ${cmd} >/dev/null 2>&1`]).status === 0;
}

runnerCommand
  .command("setup")
  .description("Scaffold a Smithers workspace so this machine can execute workflows")
  .option("--workspace <dir>", "workspace directory", process.cwd())
  .option("--location <loc>", "intended runner location label: vps | local", "local")
  .action((opts) => {
    const ws = path.resolve(opts.workspace);
    const checks = ["node", "bun", "smithers", "claude", "codex"];
    console.log("Prerequisites:", checks.map((c) => `${c}:${commandExists(c) ? "ok" : "—"}`).join("  "));
    if (!commandExists("bun") || !commandExists("smithers")) {
      console.error("\nInstall the Smithers engine first, then re-run:");
      console.error("  curl -fsSL https://bun.sh/install | bash   # if bun is missing");
      console.error("  bun add -g smithers-orchestrator");
      process.exit(1);
    }
    if (!commandExists("claude") && !commandExists("codex")) {
      console.warn("\nWarning: no 'claude' or 'codex' CLI on PATH. Workflows need at least one authed agent CLI.");
    }
    mkdirSync(ws, { recursive: true });
    console.log(`\nScaffolding Smithers workspace in ${ws} ...`);
    const init = spawnSync("smithers", ["init"], { cwd: ws, stdio: "inherit" });
    if (init.status !== 0) {
      console.error("`smithers init` failed.");
      process.exit(1);
    }
    // Overlay the Hub's bundled workflow templates (hello + imported examples) into the workspace.
    const tpl = fileURLToPath(new URL("../workflow-templates", import.meta.url));
    if (existsSync(tpl)) {
      cpSync(path.join(tpl, "workflows"), path.join(ws, ".smithers", "workflows"), { recursive: true });
      cpSync(path.join(tpl, "examples"), path.join(ws, ".smithers", "examples"), { recursive: true });
      console.log("Added Hub workflow templates (hello, fan-out-fan-in).");
    }
    console.log(`\n✓ Workspace ready. Start the runner:\n  smithers-hub runner start --workspace ${ws} --location ${opts.location}`);
  });

runnerCommand
  .command("start")
  .description("Start a Smithers runner that executes workflows for the current remote")
  .option("--workspace <dir>", "directory containing a .smithers workspace", process.cwd())
  .option("--location <loc>", "runner location label: vps | local", "local")
  .action((opts) => {
    const remote = resolveRemote(program.opts().remote);
    const env = {
      ...process.env,
      SMITHERS_HUB_URL: program.opts().url || process.env.SMITHERS_HUB_URL || remote.url,
      SMITHERS_HUB_TOKEN: program.opts().token || process.env.SMITHERS_HUB_TOKEN || remote.token,
      SMITHERS_WORKSPACE: opts.workspace,
      SMITHERS_RUNNER_LOCATION: opts.location
    };
    const child = spawn(process.execPath, [fileURLToPath(new URL("./smithers-runner.js", import.meta.url))], { stdio: "inherit", env });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program.command("mcp-config").description("Print MCP server config snippet").action(() => printMcpConfig());

const mcpCommand = program.command("mcp").description("MCP commands");
mcpCommand
  .command("install")
  .description("Configure AI client(s) to use this Hub over MCP")
  .option("--client <client>", `one of: ${"claude-code, claude-desktop, codex, cursor, windsurf, gemini, vscode"}`, "claude-code")
  .option("--all", "auto-detect and configure every AI client found on this machine")
  .option("--remote <name>", "bind to a specific org remote (default: current)")
  .option("--global", "Claude Code: write user-level config instead of a project .mcp.json")
  .action((opts) => installMcp(opts));
mcpCommand.command("config").description("Print the MCP server config snippet").action(() => printMcpConfig());

// MCP server spec — references this CLI's sibling mcp.js by absolute path and a remote name.
// No token is written here: mcp.js reads it from ~/.smithers-hub for the named remote.
function mcpServerSpec(remoteName) {
  const remote = resolveRemote(remoteName).name;
  const mcpJs = fileURLToPath(new URL("./mcp.js", import.meta.url));
  return { command: process.execPath, args: [mcpJs, "--remote", remote] };
}

function mergeJson(file, mutate) {
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

function upsertToml(file, name, server) {
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\n)\\[mcp_servers\\.${esc}\\][\\s\\S]*?(?=\\n\\[|$)`);
  let next;
  if (re.test(content)) next = content.replace(re, (m, p1) => `${p1 || ""}${block.trimEnd()}`);
  else next = `${content.replace(/\s*$/, "")}${content.trim() ? "\n\n" : ""}${block}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`);
}

function claudeDesktopConfigPath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || home, "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

const HOME = os.homedir();
function jsonWriter(getFile, key = "mcpServers", entry = (s) => ({ command: s.command, args: s.args })) {
  return (name, server, opts) => {
    const file = getFile(opts);
    mergeJson(file, (d) => {
      d[key] = d[key] || {};
      d[key][name] = entry(server);
    });
    return file;
  };
}

// Registry of supported AI clients: detection, where/how to write config, and how to activate it.
const CLIENTS = {
  "claude-code": {
    detect: () => existsSync(path.join(HOME, ".claude.json")) || existsSync(path.join(HOME, ".claude")),
    apply: jsonWriter((opts) => (opts.global ? path.join(HOME, ".claude.json") : path.join(process.cwd(), ".mcp.json"))),
    activate: "type /mcp in a Claude Code session (or reopen Claude Code in this folder) and approve it"
  },
  "claude-desktop": {
    detect: () => existsSync(path.dirname(claudeDesktopConfigPath())),
    apply: jsonWriter(() => claudeDesktopConfigPath()),
    activate: "fully quit Claude Desktop (Cmd/Ctrl+Q — not just close the window) and reopen it"
  },
  cursor: {
    detect: () => existsSync(path.join(HOME, ".cursor")),
    apply: jsonWriter(() => path.join(HOME, ".cursor", "mcp.json")),
    activate: "Cursor → Settings → MCP → enable 'smithers-hub' (or reload the window)"
  },
  windsurf: {
    detect: () => existsSync(path.join(HOME, ".codeium")),
    apply: jsonWriter(() => path.join(HOME, ".codeium", "windsurf", "mcp_config.json")),
    activate: "Windsurf → open Cascade → MCP settings → Refresh (or restart Windsurf)"
  },
  gemini: {
    detect: () => existsSync(path.join(HOME, ".gemini")),
    apply: jsonWriter(() => path.join(HOME, ".gemini", "settings.json")),
    activate: "start a new Gemini CLI session (run `gemini` again)"
  },
  vscode: {
    detect: () => existsSync(path.join(process.cwd(), ".vscode")) || existsSync(path.join(HOME, ".vscode")),
    apply: jsonWriter(() => path.join(process.cwd(), ".vscode", "mcp.json"), "servers", (s) => ({ type: "stdio", command: s.command, args: s.args })),
    activate: "VS Code → Command Palette → 'MCP: List Servers' → Start (or reload the window)"
  },
  codex: {
    detect: () => existsSync(path.join(HOME, ".codex")),
    apply: (name, server) => {
      const file = path.join(HOME, ".codex", "config.toml");
      upsertToml(file, name, server);
      return file;
    },
    activate: "start a new Codex session (it loads MCP servers on launch)"
  }
};

function installMcp(opts) {
  const remote = resolveRemote(opts.remote || program.opts().remote).name;
  const serverName = remote === "default" ? "smithers-hub" : `smithers-hub-${remote}`;
  const server = mcpServerSpec(remote);
  let ids;
  if (opts.all) {
    ids = Object.keys(CLIENTS).filter((id) => CLIENTS[id].detect());
    if (!ids.length) {
      console.log("No known AI clients detected on this machine. Use --client <name>.");
      return;
    }
  } else {
    ids = [opts.client || "claude-code"];
  }
  for (const id of ids) {
    const c = CLIENTS[id];
    if (!c) {
      console.error(`Unknown client "${id}". Known: ${Object.keys(CLIENTS).join(", ")}`);
      process.exitCode = 1;
      continue;
    }
    const file = c.apply(serverName, server, opts);
    console.log(`✓ ${id}: wrote "${serverName}" -> ${file}`);
    console.log(`    to load it: ${c.activate}`);
  }
  console.log(`\nToken is read from ~/.smithers-hub (remote "${remote}") — none is stored in the configs above.`);
}

function printMcpConfig() {
  const remote = resolveRemote(program.opts().remote).name;
  const name = remote === "default" ? "smithers-hub" : `smithers-hub-${remote}`;
  console.log(JSON.stringify({ mcpServers: { [name]: mcpServerSpec(remote) } }, null, 2));
}

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
