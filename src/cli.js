#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { HubClient } from "./apiClient.js";
import { readConfig, writeConfig, setRemote, resolveRemote } from "./config.js";
import { resolveHubUrl, resolveHubToken } from "./hubConnection.js";
import { parseJsonOption } from "./cliJson.js";
import { renderData, renderMenu, renderRunCreated } from "./cliPresentation.js";
import { normalizeRunnerTags } from "./runExecution.js";
import {
  installMcpClients,
  mcpConfigSnippet
} from "./cliMcpInstall.js";
import { setupRunnerWorkspace } from "./cliRunnerSetup.js";

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

function client(options = {}) {
  const remoteName = options.remote || program.opts().remote;
  const remote = resolveRemote(remoteName);
  const baseUrl = resolveHubUrl({ explicit: options.url || program.opts().url, remote });
  const token = resolveHubToken({ explicit: options.token || program.opts().token, remote });
  if (!token) throw new Error("No token configured. Run: runyard login");
  return new HubClient({ baseUrl, token });
}

function print(data, json) {
  for (const line of renderData(data, { json })) console.log(line);
}

function printMenu(data, json, { all = false } = {}) {
  for (const line of renderMenu(data, { json, all })) console.log(line);
}

function printRunCreated(data, json) {
  if (json) return print(data, true);
  for (const line of renderRunCreated(data)) console.log(line);
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

const invokedName = path.basename(process.argv[1] || "runyard").replace(/\.js$/, "");
// Read version straight from package.json — importing env.js here would trigger
// its data-dir/secret side effects just to print --version.
const cliVersion = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const program = new Command();
program.name(invokedName || "runyard").description("Runyard CLI — self-hosted control plane for agent runs").version(cliVersion);
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
  if (!names.length) return console.log("No remotes configured. Run: runyard login");
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
      console.error(`No remote "${name}". Run: runyard login --remote ${name}`);
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

program
  .command("menu")
  .alias("discover")
  .description("Show the next-action menu (top 5 capabilities)")
  .option("--all", "show the full capability catalog instead of the top 5")
  .action(async (opts) => {
    printMenu(await client(program.opts()).get("/api/menu"), program.opts().json, { all: Boolean(opts.all) });
  });

program.command("capabilities").description("List capabilities").option("-q, --query <query>").action(async (opts) => {
  const data = await client(program.opts()).get(`/api/capabilities${opts.query ? `?q=${encodeURIComponent(opts.query)}` : ""}`);
  print(data.capabilities, program.opts().json);
});

// `capability` is now a parent command with subcommands so we can hang the
// new `rollback` action off it cleanly. `describe` keeps the old `capability
// <id>` behavior; we register a top-level alias below so existing operator
// muscle memory (`runyard capability <id>`) keeps working.
const capabilityCommand = program.command("capability").description("Capability commands");
capabilityCommand
  .command("describe <id>")
  .description("Describe a capability")
  .action(async (id) => {
    print(await client(program.opts()).get(`/api/capabilities/${id}`), program.opts().json);
  });
capabilityCommand
  .command("versions <capability>")
  .description("List capability SHAs seen across runs (RUNYARD_CAPABILITY_VERSIONING)")
  .action(async (capability) => {
    print(await client(program.opts()).get(`/api/capabilities/${capability}/versions`), program.opts().json);
  });
capabilityCommand
  .command("rollback <capability> <sha>")
  .description("Re-run a capability pinned to a prior git SHA (requires RUNYARD_CAPABILITY_VERSIONING)")
  .option("--from-run <id>", "mark the new run as a rollback of an existing run id (parentRunId)")
  .option("-i, --input <json>", "JSON input", "{}")
  .option("--where <mode>", "execution mode: local | remote")
  .option("--execution-mode <mode>", "execution mode alias: local | remote")
  .option("--runner-location <location>", "specific runner location tag")
  .action(async (capability, sha, opts) => {
    const input = parseJsonOption(opts.input, "--input");
    const remote = resolveRemote(program.opts().remote);
    const body = {
      input,
      pin: sha,
      origin: {
        type: "cli",
        label: `CLI${remote.name ? `: ${remote.name}` : ""}`,
        remote: remote.name || "",
        command: "runyard capability rollback",
        pin: sha,
        ...(opts.fromRun ? { rollbackOf: opts.fromRun } : {})
      }
    };
    if (opts.fromRun) body.parentRunId = opts.fromRun;
    if (opts.where || opts.executionMode) body.executionMode = opts.where || opts.executionMode;
    if (opts.runnerLocation) body.runnerLocation = opts.runnerLocation;
    printRunCreated(await client(program.opts()).post(`/api/capabilities/${capability}/run`, body), program.opts().json);
  });

program
  .command("run <capability>")
  .description("Run a capability with JSON input")
  .option("-i, --input <json>", "JSON input", "{}")
  .option("--chain <json>", "JSON array of next capability steps to queue after each run succeeds")
  .option("--where <mode>", "execution mode: local | remote")
  .option("--execution-mode <mode>", "execution mode alias: local | remote")
  .option("--runner-location <location>", "specific runner location tag")
  .option("--pin <sha>", "pin this run to a specific capability git SHA (RUNYARD_CAPABILITY_VERSIONING)")
  .action(async (capability, opts) => {
    const input = parseJsonOption(opts.input, "--input");
    const remote = resolveRemote(program.opts().remote);
    const body = {
      input,
      origin: {
        type: "cli",
        label: `CLI${remote.name ? `: ${remote.name}` : ""}`,
        remote: remote.name || "",
        command: "runyard run"
      }
    };
    if (opts.chain) body.chain = parseJsonOption(opts.chain, "--chain");
    if (opts.where || opts.executionMode) body.executionMode = opts.where || opts.executionMode;
    if (opts.runnerLocation) body.runnerLocation = opts.runnerLocation;
    if (opts.pin) {
      body.pin = opts.pin;
      body.origin.pin = opts.pin;
    }
    printRunCreated(await client(program.opts()).post(`/api/capabilities/${capability}/run`, body), program.opts().json);
  });

program.command("runs").description("List runs").option("-s, --status <status>").action(async (opts) => {
  const data = await client(program.opts()).get(`/api/runs${opts.status ? `?status=${encodeURIComponent(opts.status)}` : ""}`);
  print(data.runs, program.opts().json);
});

program.command("runners").description("List registered runners and pool stats").action(async () => {
  print(await client(program.opts()).get("/api/runners"), program.opts().json);
});

program.command("run-status <id>").alias("run-detail").description("Show run detail").action(async (id) => {
  print(await client(program.opts()).get(`/api/runs/${id}`), program.opts().json);
});

program.command("logs <id>").description("Print run logs").action(async (id) => {
  const hub = client(program.opts());
  const response = await fetch(`${hub.baseUrl}/api/runs/${id}/logs`, { headers: { authorization: `Bearer ${hub.token}` } });
  console.log(await response.text());
});

// Unified run timeline tail. Streams normalized {ts, kind, source, payload}
// entries as NDJSON so operators (and downstream pipes) can watch a run's
// lifecycle without polling status + events + artifacts independently. Backed
// by /api/runs/:id/timeline. --once does a single
// snapshot; without it the loop polls every 2s using the last seen ts as the
// `since` cursor so the server never re-sends rows we already emitted.
program
  .command("tail <runId>")
  .description("Tail the unified run timeline as NDJSON ({ts, kind, source, payload})")
  .option("--once", "fetch the current timeline once and exit")
  .option("--since <iso>", "only emit entries newer than this ISO timestamp")
  .action(async (runId, opts) => {
    const hub = client(program.opts());
    const once = Boolean(opts.once || process.argv.includes("--once"));
    let since = opts.since || "";
    const fetchAll = async () => {
      // Drain pages until the server stops setting `truncated`. Each page
      // advances `since` to its last ts so the next page is contiguous.
      while (true) {
        const query = since ? `?since=${encodeURIComponent(since)}` : "";
        const page = await hub.get(`/api/runs/${runId}/timeline${query}`);
        for (const entry of page.entries || []) {
          console.log(JSON.stringify(entry));
          if (entry.ts) since = entry.ts;
        }
        if (page.nextSince && page.nextSince > since) since = page.nextSince;
        if (!page.truncated) break;
      }
    };
    await fetchAll();
    if (once) {
      process.exit(0);
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        await fetchAll();
      } catch (error) {
        // Surface transient errors as NDJSON so the tail stream stays
        // machine-parseable; the loop keeps polling.
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            kind: "error",
            source: "cli",
            payload: { message: String(error.message || error) }
          })
        );
      }
    }
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
  .option("--location <loc>", "runner location label: vps | local", "local")
  .action(async (opts) => {
    const tags = normalizeRunnerTags(
      opts.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      opts.location
    );
    const data = await client(program.opts()).post("/api/runners/register", {
      name: opts.name,
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      tags
    });
    print(data, program.opts().json);
  });

runnerCommand
  .command("setup")
  .description("Scaffold a Smithers workspace so this machine can execute workflows")
  .option("--workspace <dir>", "workspace directory", process.cwd())
  .option("--location <loc>", "intended runner location label: vps | local", "local")
  .action((opts) => {
    setupRunnerWorkspace(opts);
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
      RUNYARD_HUB_URL: resolveHubUrl({ explicit: program.opts().url, remote }),
      RUNYARD_HUB_TOKEN: resolveHubToken({ explicit: program.opts().token, remote }),
      SMITHERS_WORKSPACE: opts.workspace,
      SMITHERS_RUNNER_LOCATION: opts.location
    };
    const child = spawn(process.execPath, [fileURLToPath(new URL("./runner.js", import.meta.url))], { stdio: "inherit", env });
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

function installMcp(opts) {
  installMcpClients(opts, {
    currentRemote: program.opts().remote,
    resolveRemote,
    mcpJs: fileURLToPath(new URL("./mcp.js", import.meta.url)),
    fail: (message) => {
      console.error(message);
      process.exitCode = 1;
    }
  });
}

function printMcpConfig() {
  const remote = resolveRemote(program.opts().remote).name;
  console.log(JSON.stringify(mcpConfigSnippet({
    remoteName: remote,
    resolveRemote,
    mcpJs: fileURLToPath(new URL("./mcp.js", import.meta.url))
  }), null, 2));
}

// `runyard update [tag]` — operator-initiated, self-healing apply ON THIS HOST.
// Delegates to scripts/runyard-update.sh (drain -> swap -> restart -> health ->
// auto-rollback). Never automatic; this is the human pulling the trigger. Runs
// the LOCAL checkout's script, so it only works from a full RunYard checkout
// (the thin CLI bundle installed via /install.sh does not ship scripts/).
program
  .command("update [tag]")
  .description("Apply a RunYard update on this host (drain, swap, restart, verify, auto-rollback). Operator-initiated.")
  .option("--units <units>", "space-separated systemd units to restart (default: 'runyard runyard-runner')")
  .option("--grace-ms <ms>", "bounded drain grace window in ms before aborting (default ~45m)")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(async (tag, opts) => {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const script = path.join(root, "scripts", "runyard-update.sh");
    if (!existsSync(script)) {
      console.error(`Update script not found at ${script}.`);
      console.error("`runyard update` runs from a full RunYard checkout on the host, not the thin CLI bundle.");
      process.exit(1);
    }
    if (!opts.yes) {
      const answer = await ask(`Apply update${tag ? ` to ${tag}` : " to the latest release"} on this host now? Runners drain first. [y/N] `);
      if (!/^y(es)?$/i.test(String(answer).trim())) {
        console.log("Aborted.");
        return;
      }
    }
    const childEnv = { ...process.env };
    if (opts.units != null) childEnv.RUNYARD_UNITS = opts.units;
    if (opts.graceMs) childEnv.RUNYARD_DRAIN_GRACE_MS = String(opts.graceMs);
    const args = [script];
    if (tag) args.push(tag);
    const result = spawnSync("bash", args, { cwd: root, stdio: "inherit", env: childEnv });
    process.exit(result.status == null ? 1 : result.status);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
