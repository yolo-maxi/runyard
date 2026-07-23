#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { renderCiPipeline, renderCiRepoList, renderData, renderMenu, renderNegotiation, renderRunCreated } from "./cliPresentation.js";
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
  if (data?.negotiation) for (const line of renderNegotiation(data)) console.log(line);
}

function printNegotiation(data, json) {
  if (json) return print(data, true);
  for (const line of renderNegotiation(data)) console.log(line);
}

// --max-tokens / --max-cost flags → a run budget body ({ maxTokens,
// maxCostMicros }). --max-cost is US dollars for humans; the API speaks
// micro-USD. Returns null when neither flag was passed.
function budgetFromFlags(opts = {}) {
  const budget = {};
  if (opts.maxTokens !== undefined) {
    const tokens = Number(opts.maxTokens);
    if (!Number.isFinite(tokens) || tokens <= 0) throw new Error("--max-tokens must be a positive number");
    budget.maxTokens = Math.floor(tokens);
  }
  if (opts.maxCost !== undefined) {
    const usd = Number(opts.maxCost);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error("--max-cost must be a positive number of US dollars");
    budget.maxCostMicros = Math.floor(usd * 1_000_000);
  }
  return Object.keys(budget).length ? budget : null;
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
  .description("Show the next-action menu (top 5 workflows)")
  .option("--all", "show the full workflow catalog instead of the top 5")
  .action(async (opts) => {
    printMenu(await client(program.opts()).get("/api/menu"), program.opts().json, { all: Boolean(opts.all) });
  });

program
  .command("hooks")
  .description("List post-run hook profiles (optional side effects run after a workflow's gates pass)")
  .option("--workflow <slug>", "show only profiles this workflow may select via input.postRunHooks")
  .option("--capability <slug>", "legacy alias for --workflow")
  .option("--all", "include disabled profiles (admin)")
  .action(async (opts) => {
    const query = new URLSearchParams();
    if (opts.workflow || opts.capability) query.set("workflow", opts.workflow || opts.capability);
    if (opts.all) query.set("all", "1");
    const qs = query.toString();
    const data = await client(program.opts()).get(`/api/hooks${qs ? `?${qs}` : ""}`);
    print(data.hookProfiles, program.opts().json);
  });

const hookCommand = program.command("hook").description("Post-run hook profile commands");
hookCommand
  .command("describe <slug>")
  .description("Describe a hook profile (admins see config + readiness)")
  .action(async (slug) => {
    print(await client(program.opts()).get(`/api/hooks/${encodeURIComponent(slug)}`), program.opts().json);
  });
hookCommand
  .command("validate <slug>")
  .description("Check whether a hook profile is executable now (admin; reports missing secret names only)")
  .action(async (slug) => {
    print(await client(program.opts()).post(`/api/hooks/${encodeURIComponent(slug)}/validate`, {}), program.opts().json);
  });

function workflowListAction(opts) {
  return async () => {
    const data = await client(program.opts()).get(`/api/workflows${opts.query ? `?q=${encodeURIComponent(opts.query)}` : ""}`);
    print(data.workflows, program.opts().json);
  };
}

program.command("workflows").description("List workflows").option("-q, --query <query>").action((opts) => workflowListAction(opts)());
program.command("capabilities").description("Legacy alias for workflows").option("-q, --query <query>").action((opts) => workflowListAction(opts)());

const workflowCommand = program.command("workflow").description("Workflow commands");
workflowCommand
  .command("describe <id>")
  .description("Describe a workflow")
  .action(async (id) => {
    print(await client(program.opts()).get(`/api/workflows/${id}`), program.opts().json);
  });
workflowCommand
  .command("versions <workflow>")
  .description("List workflow SHAs seen across runs (RUNYARD_CAPABILITY_VERSIONING)")
  .action(async (workflow) => {
    print(await client(program.opts()).get(`/api/workflows/${workflow}/versions`), program.opts().json);
  });
workflowCommand
  .command("rollback <workflow> <sha>")
  .description("Re-run a workflow pinned to a prior git SHA (requires RUNYARD_CAPABILITY_VERSIONING)")
  .option("--from-run <id>", "mark the new run as a rollback of an existing run id (parentRunId)")
  .option("-i, --input <json>", "JSON input", "{}")
  .option("--where <mode>", "execution mode: local | remote")
  .option("--execution-mode <mode>", "execution mode alias: local | remote")
  .option("--runner-location <location>", "specific runner location tag")
  .action(async (workflow, sha, opts) => {
    const input = parseJsonOption(opts.input, "--input");
    const remote = resolveRemote(program.opts().remote);
    const body = {
      input,
      pin: sha,
      origin: {
        type: "cli",
        label: `CLI${remote.name ? `: ${remote.name}` : ""}`,
        remote: remote.name || "",
        command: "runyard workflow rollback",
        pin: sha,
        ...(opts.fromRun ? { rollbackOf: opts.fromRun } : {})
      }
    };
    if (opts.fromRun) body.parentRunId = opts.fromRun;
    if (opts.where || opts.executionMode) body.executionMode = opts.where || opts.executionMode;
    if (opts.runnerLocation) body.runnerLocation = opts.runnerLocation;
    printRunCreated(await client(program.opts()).post(`/api/workflows/${workflow}/run`, body), program.opts().json);
  });

const capabilityCommand = program.command("capability").description("Legacy workflow alias");
capabilityCommand.command("describe <id>").action(async (id) => {
  print(await client(program.opts()).get(`/api/workflows/${id}`), program.opts().json);
});

program
  .command("run <workflow>")
  .description("Run a workflow with JSON input")
  .option("-i, --input <json>", "JSON input", "{}")
  .option("--chain <json>", "JSON array of next workflow steps to queue after each run succeeds")
  .option("--where <mode>", "execution mode: local | remote")
  .option("--execution-mode <mode>", "execution mode alias: local | remote")
  .option("--runner-location <location>", "specific runner location tag")
  .option("--pin <sha>", "pin this run to a specific workflow git SHA (RUNYARD_CAPABILITY_VERSIONING)")
  .option("--max-tokens <tokens>", "hard budget: stop the run once its metered usage reaches this many tokens")
  .option("--max-cost <usd>", "hard budget: stop the run once its metered cost reaches this many US dollars")
  .option("--work-item <id>", "attach the run to a work item (ticket) on the Work board")
  .option("--negotiate", "preflight first: enqueue only when ready; otherwise print the negotiation state (and saved draft) without creating a run")
  .action(async (workflow, opts) => {
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
    const budget = budgetFromFlags(opts);
    if (budget) body.budget = budget;
    if (opts.workItem) body.workItemId = opts.workItem;
    if (opts.negotiate) body.negotiate = true;
    try {
      printRunCreated(await client(program.opts()).post(`/api/workflows/${workflow}/run`, body), program.opts().json);
    } catch (error) {
      // In negotiate mode a non-ready preflight is a structured negotiation
      // response (422 needs_input / 409 blocked), not a CLI crash.
      if (opts.negotiate && error.response?.negotiation) {
        printNegotiation(error.response, program.opts().json);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

program
  .command("preflight <workflow>")
  .description("Dry-run the deterministic run-creation preflight: report ready/needs_input/blocked without creating anything")
  .option("-i, --input <json>", "JSON input", "{}")
  .option("--where <mode>", "execution mode: local | remote")
  .option("--execution-mode <mode>", "execution mode alias: local | remote")
  .option("--runner-location <location>", "specific runner location tag")
  .option("--max-tokens <tokens>", "hard budget to validate: maximum metered tokens for the run")
  .option("--max-cost <usd>", "hard budget to validate: maximum metered cost in US dollars")
  .action(async (workflow, opts) => {
    const body = { input: parseJsonOption(opts.input, "--input") };
    if (opts.where || opts.executionMode) body.executionMode = opts.where || opts.executionMode;
    if (opts.runnerLocation) body.runnerLocation = opts.runnerLocation;
    const budget = budgetFromFlags(opts);
    if (budget) body.budget = budget;
    printNegotiation(await client(program.opts()).post(`/api/workflows/${workflow}/preflight`, body), program.opts().json);
  });

const workflowPackageCommand = program.command("workflow-package").description("Export/import portable workflow files");
workflowPackageCommand
  .command("export <workflow>")
  .description("Export a workflow as a .runyard-workflow.json file")
  .option("-o, --output <path>", "write to this file instead of stdout")
  .action(async (workflow, opts) => {
    const data = await client(program.opts()).get(`/api/workflow-packages/workflows/${encodeURIComponent(workflow)}/export`);
    const pkg = data.workflowPackage;
    const json = JSON.stringify(pkg, null, 2);
    if (opts.output) {
      writeFileSync(opts.output, `${json}\n`);
      if (!program.opts().json) {
        console.log(`Exported ${pkg.capability.slug} to ${opts.output}`);
        console.log(`contentHash ${pkg.contentHash}`);
        return;
      }
    }
    console.log(json);
  });
workflowPackageCommand
  .command("validate <file>")
  .description("Validate a .runyard-workflow.json file without importing it")
  .action(async (file) => {
    const workflowPackage = JSON.parse(readFileSync(file, "utf8"));
    print(await client(program.opts()).post("/api/workflow-packages/validate", { workflowPackage }), program.opts().json);
  });
workflowPackageCommand
  .command("preview <file>")
  .description("Preview import requirements and disabled workflow shape")
  .option("--slug <slug>", "import under a different workflow slug")
  .action(async (file, opts) => {
    const workflowPackage = JSON.parse(readFileSync(file, "utf8"));
    print(await client(program.opts()).post("/api/workflow-packages/preview", { workflowPackage, slug: opts.slug || "" }), program.opts().json);
  });
workflowPackageCommand
  .command("import <file>")
  .description("Import a workflow package as a disabled workflow")
  .option("--slug <slug>", "import under a different workflow slug")
  .action(async (file, opts) => {
    const workflowPackage = JSON.parse(readFileSync(file, "utf8"));
    print(await client(program.opts()).post("/api/workflow-packages/import", { workflowPackage, slug: opts.slug || "" }), program.opts().json);
  });

program.command("runs").description("List runs").option("-s, --status <status>").action(async (opts) => {
  const data = await client(program.opts()).get(`/api/runs${opts.status ? `?status=${encodeURIComponent(opts.status)}` : ""}`);
  print(data.runs, program.opts().json);
});

program
  .command("attention")
  .description("Show runs whose next step is a human action: paused (resume), waiting for approval (decide), or stopped at their budget in the last 7 days (raise the budget and re-run)")
  .action(async () => {
    const data = await client(program.opts()).get("/api/runs/attention");
    if (program.opts().json) return print(data, true);
    const { counts = {}, attention = {} } = data;
    const total = (counts.paused || 0) + (counts.waitingApproval || 0) + (counts.budgetStopped || 0);
    if (!total) {
      console.log("Nothing needs attention.");
      if (counts.pendingApprovals) console.log(`${counts.pendingApprovals} approval card(s) pending — see: runyard approvals`);
      return;
    }
    const sections = [
      ["Paused (resume with: runyard resume <id>)", attention.paused],
      ["Waiting for approval (decide with: runyard approvals)", attention.waitingApproval],
      ["Stopped at budget in the last 7 days (raise the budget and re-run)", attention.budgetStopped]
    ];
    for (const [heading, runs] of sections) {
      if (!runs?.length) continue;
      console.log(`${heading} — ${runs.length}`);
      for (const run of runs) {
        const reason = run.pause?.reason || run.reasonHint || run.error || "";
        console.log(`  ${run.id}  ${run.capabilitySlug || ""}  ${run.title || ""}${reason ? `  (${String(reason).slice(0, 80)})` : ""}`);
      }
    }
  });

// --- Work items (tickets) ---
// The work-item body fields shared by create and update, from CLI flags.
function workItemBodyFromFlags(opts = {}) {
  const body = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.project !== undefined) body.project = opts.project;
  if (opts.type !== undefined) body.type = opts.type;
  if (opts.status !== undefined) body.status = opts.status;
  if (opts.priority !== undefined) body.priority = opts.priority;
  if (opts.owner !== undefined) body.owner = opts.owner;
  if (opts.requester !== undefined) body.requester = opts.requester;
  if (opts.acceptance !== undefined) body.acceptanceCriteria = opts.acceptance;
  if (opts.nextAction !== undefined) body.nextAction = opts.nextAction;
  if (opts.blockedReason !== undefined) body.blockedReason = opts.blockedReason;
  if (opts.due !== undefined) body.dueAt = opts.due;
  return body;
}

function printWorkItemLine(item) {
  const runs = item.runs || {};
  const extras = [
    item.priority && item.priority !== "normal" ? item.priority : "",
    item.project || "",
    item.owner ? `@${item.owner}` : "",
    runs.total ? `${runs.total} run(s)` : "",
    runs.attention ? `${runs.attention} need(s) attention` : ""
  ].filter(Boolean).join(" · ");
  console.log(`${item.id}  [${item.status}]  ${item.title}${extras ? `  (${extras})` : ""}`);
}

program
  .command("work")
  .description("List work items (tickets) on the Work board")
  .option("-s, --status <status>", "filter by lifecycle status (intake..archived)")
  .option("--project <project>", "filter by project")
  .option("--owner <owner>", "filter by owner")
  .option("--type <type>", "filter by type (feature, bug, research, release, maintenance, idea)")
  .option("-q, --query <text>", "substring search across title/description/project/id")
  .option("--archived", "include archived items")
  .action(async (opts) => {
    const query = new URLSearchParams();
    if (opts.status) query.set("status", opts.status);
    if (opts.project) query.set("project", opts.project);
    if (opts.owner) query.set("owner", opts.owner);
    if (opts.type) query.set("type", opts.type);
    if (opts.query) query.set("q", opts.query);
    if (opts.archived) query.set("includeArchived", "true");
    const qs = query.toString();
    const data = await client(program.opts()).get(`/api/work-items${qs ? `?${qs}` : ""}`);
    if (program.opts().json) return print(data, true);
    const items = data.workItems || [];
    if (!items.length) return console.log("No work items. Create one with: runyard work-item create --title \"...\"");
    for (const item of items) printWorkItemLine(item);
  });

const workItemCommand = program.command("work-item").description("Work item (ticket) commands");
workItemCommand
  .command("show <id>")
  .description("Show a work item with linked runs, approvals, artifacts, and ticket history")
  .action(async (id) => {
    print(await client(program.opts()).get(`/api/work-items/${encodeURIComponent(id)}`), program.opts().json);
  });
workItemCommand
  .command("create")
  .description("Create a work item (ticket)")
  .requiredOption("--title <title>", "short human-readable title")
  .option("--description <text>", "what we are trying to do and why")
  .option("--project <project>")
  .option("--type <type>", "feature | bug | research | release | maintenance | idea")
  .option("--status <status>", "lifecycle status (default intake)")
  .option("--priority <priority>", "urgent | high | normal | low")
  .option("--owner <owner>")
  .option("--requester <requester>")
  .option("--acceptance <text>", "acceptance criteria")
  .option("--next-action <text>", "the single next concrete action")
  .option("--due <iso>", "due/target date")
  .action(async (opts) => {
    const data = await client(program.opts()).post("/api/work-items", workItemBodyFromFlags(opts));
    if (program.opts().json) return print(data, true);
    printWorkItemLine(data.workItem);
  });
workItemCommand
  .command("update <id>")
  .description("Update a work item: edit fields or move it across the board with --status")
  .option("--title <title>")
  .option("--description <text>")
  .option("--project <project>")
  .option("--type <type>")
  .option("--status <status>", "intake | triaged | ready | running | waiting | blocked | review | shipped | accepted | archived")
  .option("--priority <priority>")
  .option("--owner <owner>")
  .option("--requester <requester>")
  .option("--acceptance <text>")
  .option("--next-action <text>")
  .option("--blocked-reason <text>", "why the ticket cannot progress (set when moving to blocked)")
  .option("--due <iso>")
  .action(async (id, opts) => {
    const body = workItemBodyFromFlags(opts);
    if (!Object.keys(body).length) throw new Error("Nothing to update — pass at least one field flag.");
    const data = await client(program.opts()).patch(`/api/work-items/${encodeURIComponent(id)}`, body);
    if (program.opts().json) return print(data, true);
    printWorkItemLine(data.workItem);
  });
workItemCommand
  .command("link <id> <runId>")
  .description("Link a run to a work item (a run belongs to at most one ticket; relinking moves it)")
  .action(async (id, runId) => {
    print(await client(program.opts()).post(`/api/work-items/${encodeURIComponent(id)}/link-run`, { runId }), program.opts().json);
  });
workItemCommand
  .command("unlink <id> <runId>")
  .description("Unlink a run from a work item")
  .action(async (id, runId) => {
    print(await client(program.opts()).post(`/api/work-items/${encodeURIComponent(id)}/unlink-run`, { runId }), program.opts().json);
  });

// --- Boards (configured software-factory views over work items) ---
const boardCommand = program.command("board").description("Board commands: configured views over work items (the factory surfaces)");
boardCommand
  .command("list")
  .description("List boards (the default board is what /app#work shows)")
  .action(async () => {
    const data = await client(program.opts()).get("/api/boards");
    if (program.opts().json) return print(data, true);
    const boards = data.boards || [];
    if (!boards.length) return console.log("No boards.");
    for (const board of boards) {
      console.log(`${board.slug}${board.isDefault ? "  (default)" : ""}  ${board.title}${board.project ? `  [project: ${board.project}]` : ""}`);
    }
  });
boardCommand
  .command("show <slug>")
  .description("Show a board: lanes with counts and the tickets in each")
  .option("--archived", "include archived items")
  .action(async (slug, opts) => {
    const suffix = opts.archived ? "?includeArchived=true" : "";
    const data = await client(program.opts()).get(`/api/boards/${encodeURIComponent(slug)}${suffix}`);
    if (program.opts().json) return print(data, true);
    const { board, lanes = [], workItems = [] } = data;
    console.log(`${board.title} (${board.slug})${board.isDefault ? " — default board" : ""}`);
    if (board.description) console.log(board.description);
    for (const lane of lanes) {
      console.log(`\n${lane.label} (${lane.count})${lane.hint ? ` — ${lane.hint}` : ""}`);
      for (const item of workItems.filter((candidate) => lane.statuses.includes(candidate.status))) {
        printWorkItemLine(item);
      }
    }
  });
boardCommand
  .command("create")
  .description("Create a board (lanes default to the standard seven-column factory layout)")
  .requiredOption("--slug <slug>", "lowercase letters/digits/hyphens")
  .requiredOption("--title <title>")
  .option("--description <text>")
  .option("--project <project>", "scope the board to one project ('' = all work items)")
  .option("--default", "make this the instance default board")
  .action(async (opts) => {
    const body = { slug: opts.slug, title: opts.title };
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.project !== undefined) body.project = opts.project;
    if (opts.default) body.isDefault = true;
    print(await client(program.opts()).post("/api/boards", body), program.opts().json);
  });
boardCommand
  .command("update <slug>")
  .description("Update a board's title, description, project scope, or default flag")
  .option("--title <title>")
  .option("--description <text>")
  .option("--project <project>")
  .option("--default", "make this the instance default board")
  .action(async (slug, opts) => {
    const body = {};
    if (opts.title !== undefined) body.title = opts.title;
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.project !== undefined) body.project = opts.project;
    if (opts.default) body.isDefault = true;
    if (!Object.keys(body).length) throw new Error("Nothing to update — pass at least one field flag.");
    print(await client(program.opts()).patch(`/api/boards/${encodeURIComponent(slug)}`, body), program.opts().json);
  });

// Board definitions: portable JSON documents describing a whole kanban —
// lanes, guards, triggers, transition policy, and optional schedule
// hookups. The subcommands mirror the API/MCP surface so agents can
// provision, validate, export, and inspect boards from files without
// touching the web UI.
const boardDefinitionCommand = boardCommand
  .command("definition")
  .description("Portable board definitions (JSON documents): validate, import, export, examples");
boardDefinitionCommand
  .command("list")
  .description("List boards as portable definition summaries plus built-in example slugs")
  .action(async () => {
    const data = await client(program.opts()).get("/api/board-definitions");
    if (program.opts().json) return print(data, true);
    for (const summary of data.definitions || []) {
      console.log(`${summary.slug}${summary.isDefault ? "  (default)" : ""}  ${summary.title}  lanes=${summary.laneCount}  policy=${summary.hasTransitionPolicy ? "yes" : "no"}${summary.project ? `  [project: ${summary.project}]` : ""}`);
    }
    if (data.examples?.length) {
      console.log("\nExamples:");
      for (const example of data.examples) console.log(`  ${example.slug}  ${example.title}`);
    }
  });
boardDefinitionCommand
  .command("example <slug>")
  .description("Print a built-in example board definition as JSON")
  .action(async (slug) => {
    const data = await client(program.opts()).get(`/api/board-definitions/examples/${encodeURIComponent(slug)}`);
    console.log(JSON.stringify(data.definition, null, 2));
  });
boardDefinitionCommand
  .command("export <slug>")
  .description("Export a board as a portable JSON definition document (stdout)")
  .action(async (slug) => {
    const data = await client(program.opts()).get(`/api/boards/${encodeURIComponent(slug)}/definition`);
    console.log(JSON.stringify(data.definition, null, 2));
  });
boardDefinitionCommand
  .command("validate")
  .description("Validate a board definition JSON file without importing it")
  .requiredOption("--file <path>", "path to a JSON document")
  .action(async (opts) => {
    const definition = JSON.parse(readFileSync(opts.file, "utf8"));
    print(await client(program.opts()).post("/api/board-definitions/validate", { definition }), program.opts().json);
  });
boardDefinitionCommand
  .command("import")
  .description("Import a board definition JSON file, creating or updating the board and reconciling any schedule hookups")
  .requiredOption("--file <path>", "path to a JSON document")
  .option("--slug <slug>", "override the definition's slug (provision multiple boards from one template)")
  .action(async (opts) => {
    const definition = JSON.parse(readFileSync(opts.file, "utf8"));
    const body = { definition, ...(opts.slug ? { slug: opts.slug } : {}) };
    print(await client(program.opts()).post("/api/board-definitions/import", body), program.opts().json);
  });
boardCommand
  .command("policy <slug>")
  .description("Show a board's transition policy: every allowed move, who can drive it, and the denied-move message")
  .action(async (slug) => {
    const data = await client(program.opts()).get(`/api/boards/${encodeURIComponent(slug)}/transitions`);
    if (program.opts().json) return print(data, true);
    if (!data.transitions?.length) return console.log(`No explicit transition policy for board "${slug}" — every cross-lane move is unrestricted.`);
    console.log(`Board ${data.board?.title || slug} transition policy:`);
    for (const row of data.transitions) {
      const bits = [];
      if (row.allow.manual) bits.push("manual");
      if (row.allow.workflows?.length) bits.push(`workflows: ${row.allow.workflows.join(", ")}`);
      if (row.allow.runOrigins?.length) bits.push(`runOrigins: ${row.allow.runOrigins.join(", ")}`);
      if (row.allow.actors?.length) bits.push(`actors: ${row.allow.actors.join(", ")}`);
      if (row.allow.actorRoles?.length) bits.push(`roles: ${row.allow.actorRoles.join(", ")}`);
      console.log(`  ${row.fromLabel || row.from} → ${row.toLabel || row.to}  allow: ${bits.join(" · ") || "(nobody)"}${row.message ? `\n    ${row.message}` : ""}`);
    }
  });
boardCommand
  .command("check <slug>")
  .description("Preflight a proposed lane move against a board's transition policy (no state changes)")
  .requiredOption("--from <status>", "current status")
  .requiredOption("--to <status>", "target status")
  .option("--actor-role <role>", "manual, human, agent, runner, schedule, workflow, system")
  .option("--workflow <slug>", "declare the acting workflow slug")
  .option("--run-origin <origin>", "e.g. schedule, workflow, cli")
  .option("--run-id <id>")
  .action(async (slug, opts) => {
    const body = {
      fromStatus: opts.from,
      toStatus: opts.to,
      actorRole: opts.actorRole,
      workflowSlug: opts.workflow,
      runOrigin: opts.runOrigin,
      runId: opts.runId
    };
    print(await client(program.opts()).post(`/api/boards/${encodeURIComponent(slug)}/transitions/check`, body), program.opts().json);
  });

program
  .command("usage [runId]")
  .description("Show metered usage/cost: a fleet rollup per workflow (no run id) or one run's usage detail")
  .option("--days <days>", "rollup window in days (1-365)", "30")
  .action(async (runId, opts) => {
    const hub = client(program.opts());
    if (runId) return print(await hub.get(`/api/runs/${encodeURIComponent(runId)}/usage`), program.opts().json);
    const data = await hub.get(`/api/usage/summary?days=${encodeURIComponent(opts.days)}`);
    if (program.opts().json) return print(data, true);
    const fmtCost = (micros) => `$${((Number(micros) || 0) / 1_000_000).toFixed(2)}`;
    const totals = data.totals || {};
    console.log(`Last ${data.window?.days} days: ${totals.totalTokens || 0} tokens · ${fmtCost(totals.costMicros)} · ${totals.calls || 0} calls · ${totals.meteredRuns || 0} metered runs`);
    if (data.budgetStopped) console.log(`${data.budgetStopped} run(s) stopped at their budget in this window.`);
    for (const row of data.byWorkflow || []) {
      console.log(`  ${row.workflow}  ${row.totalTokens} tokens · ${fmtCost(row.costMicros)} · ${row.meteredRuns} run(s)`);
    }
  });

program.command("runners").description("List registered runners and pool stats").action(async () => {
  print(await client(program.opts()).get("/api/runners"), program.opts().json);
});

program.command("run-status <id>").alias("run-detail").description("Show run detail").action(async (id) => {
  print(await client(program.opts()).get(`/api/runs/${id}`), program.opts().json);
});

program
  .command("flow <id>")
  .description("Show a run's execution flow: the workflow's steps with per-step states folded from the run's events")
  .action(async (id) => {
    const data = await client(program.opts()).get(`/api/runs/${encodeURIComponent(id)}/flow`);
    if (program.opts().json) return print(data, true);
    const glyphs = { done: "✓", active: "▶", failed: "✗", waiting: "⏸", cancelled: "⊘", skipped: "»", pending: "·" };
    console.log(`${data.name}  [${data.status}]${data.currentStep ? `  step: ${data.currentStep}` : ""}`);
    for (const node of data.nodes || []) {
      if (node.kind === "entry" || node.type === "entry") continue;
      console.log(`  ${glyphs[node.state] || "·"} ${node.label || node.id}  ${node.state}${node.errors ? `  (${node.errors} error event(s))` : ""}`);
    }
    for (const approval of data.pendingApprovals || []) {
      console.log(`  ⏸ approval pending: ${approval.title} (${approval.id})`);
    }
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

program.command("pause <runId>").description("Pause an active run (recoverable interruption; keeps its checkpoint for resume)").option("-r, --reason <reason>", "pause reason, e.g. credits_exhausted, manual").option("-m, --message <message>", "").action(async (runId, opts) => {
  const data = await client(program.opts()).post(`/api/runs/${runId}/pause`, { reason: opts.reason || "manual", message: opts.message || "", pausedBy: "operator" });
  if (program.opts().json) return print(data, true);
  const pause = data.pause || {};
  console.log(`Run ${runId} paused (${pause.reason || "manual"}).`);
  if (pause.resume?.smithersRunId) console.log(`Engine checkpoint ${pause.resume.smithersRunId} recorded — resume continues from it.`);
  else console.log("No engine checkpoint recorded yet; the runner attaches one when it observes the pause.");
  console.log(`Resume with: runyard resume ${runId}`);
});

program.command("resume <runId>").description("Resume a paused run: continues from its recorded engine checkpoint when one exists, otherwise re-runs from scratch").option("--from-scratch", "discard the recorded checkpoint and runner pin; re-run from scratch on any runner").action(async (runId, opts) => {
  const data = await client(program.opts()).post(`/api/runs/${runId}/resume`, opts.fromScratch ? { strategy: "rerun_from_scratch" } : {});
  if (program.opts().json) return print(data, true);
  const resume = data.resume || {};
  console.log(resume.strategy === "smithers_resume"
    ? `Run ${runId} resumed from checkpoint ${resume.smithersRunId} (attempt ${resume.attempt}).`
    : `Run ${runId} re-queued from scratch (attempt ${resume.attempt}) — no engine checkpoint applies.`);
  if (data.warning) console.log(`⚠ ${data.warning}`);
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
  .option("--scopes <scopes>", "comma-separated scopes (api, mcp, approvals, read, runner, admin); read alone makes a read-only token", "api,mcp")
  .option("--expires-in-days <days>", "expiry in days (0 = never)", "0")
  .action(async (name, opts) => {
    const scopes = opts.scopes.split(",").map((scope) => scope.trim()).filter(Boolean);
    print(await client(program.opts()).post("/api/tokens", { name, scopes, expiresInDays: Number(opts.expiresInDays || 0) }), true);
  });

program.command("token-scopes").description("Explain the token scope vocabulary and named presets (admin)").action(async () => {
  const data = await client(program.opts()).get("/api/tokens/scopes");
  if (program.opts().json) return print(data, true);
  console.log("Scopes:");
  for (const meta of data.scopes || []) {
    console.log(`  ${String(meta.scope || "").padEnd(10)} ${meta.summary || ""}`);
  }
  console.log("Presets (pass the scopes to token-create --scopes):");
  for (const preset of data.presets || []) {
    console.log(`  ${String(preset.id || "").padEnd(16)} ${(preset.scopes || []).join(",")}  ${preset.summary || ""}`);
  }
  if (data.defaultScopes) console.log(`Default scopes: ${data.defaultScopes.join(",")}`);
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

// --- CI: connected repositories + pipelines (specs/ci-platform.md) ----------
const repoCommand = program.command("repo").description("CI repository connections: list, sync, enable/disable, trust policy");
repoCommand
  .command("list")
  .description("List CI-connected repositories with enablement and trust policy")
  .option("--enabled", "only repositories enabled for CI")
  .action(async (opts) => {
    const data = await client(program.opts()).get(`/api/ci/repos${opts.enabled ? "?enabled=1" : ""}`);
    if (program.opts().json) return print(data, true);
    for (const line of renderCiRepoList(data)) console.log(line);
  });
repoCommand
  .command("sync")
  .description("Sync installations + repositories from the GitHub App (admin; never auto-enables CI)")
  .action(async () => {
    const data = await client(program.opts()).post("/api/ci/repos/sync", {});
    if (program.opts().json) return print(data, true);
    console.log(`Synced ${data.synced.installations} installation(s), ${data.synced.repos} repositorie(s).`);
    for (const line of renderCiRepoList(data)) console.log(line);
  });
repoCommand
  .command("enable <repo>")
  .description("Enable CI for a connected repository (admin). <repo> is the row id or owner/name.")
  .action(async (repo) => {
    print(await client(program.opts()).post(`/api/ci/repos/-/enable?repo=${encodeURIComponent(repo)}`, {}), program.opts().json);
  });
repoCommand
  .command("disable <repo>")
  .description("Disable CI for a connected repository (admin)")
  .action(async (repo) => {
    print(await client(program.opts()).post(`/api/ci/repos/-/disable?repo=${encodeURIComponent(repo)}`, {}), program.opts().json);
  });
repoCommand
  .command("trust <repo>")
  .description("Update a repository's trust policy (admin)")
  .option("--level <level>", "trusted | untrusted")
  .option("--allow-native", "allow native host execution (requires --level trusted AND runner opt-in)")
  .option("--no-allow-native", "forbid native host execution")
  .option("--runner-tags <tags>", "comma-separated runner tag allowlist")
  .action(async (repo, opts) => {
    const body = {};
    if (opts.level !== undefined) body.level = opts.level;
    if (opts.allowNative !== undefined) body.allowNative = opts.allowNative;
    if (opts.runnerTags !== undefined) body.runnerTags = opts.runnerTags.split(",").map((t) => t.trim()).filter(Boolean);
    print(await client(program.opts()).patch(`/api/ci/repos/-/trust?repo=${encodeURIComponent(repo)}`, body), program.opts().json);
  });

const ciCommand = program.command("ci").description("CI pipelines: dispatch, status, cancel, rerun");
ciCommand
  .command("dispatch <repo>")
  .description("Manually dispatch CI for a connected repository at an exact revision")
  .option("--ref <ref>", "branch, tag, or sha (default: the repo's default branch)")
  .action(async (repo, opts) => {
    const body = { repo, ...(opts.ref ? { ref: opts.ref } : {}) };
    const data = await client(program.opts()).post("/api/ci/dispatch", body);
    if (program.opts().json) return print(data, true);
    for (const line of renderCiPipeline(data)) console.log(line);
  });
ciCommand
  .command("pipelines")
  .description("List recent CI pipelines")
  .option("--repo <repo>", "filter by connected repository (id or owner/name)")
  .option("--limit <n>", "max pipelines", "20")
  .action(async (opts) => {
    const suffix = `?limit=${encodeURIComponent(opts.limit)}${opts.repo ? `&repo=${encodeURIComponent(opts.repo)}` : ""}`;
    const data = await client(program.opts()).get(`/api/ci/pipelines${suffix}`);
    if (program.opts().json) return print(data, true);
    const pipelines = data.pipelines || [];
    if (!pipelines.length) return console.log("No CI pipelines yet.");
    for (const pipeline of pipelines) {
      const trigger = pipeline.trigger || {};
      console.log(
        `${pipeline.id}\t${pipeline.run?.status || "?"}\t${trigger.event || "?"}${trigger.prNumber ? ` PR#${trigger.prNumber}` : ""}\t${(pipeline.commitSha || "").slice(0, 12)}\t${pipeline.createdAt}`
      );
    }
  });
ciCommand
  .command("status <pipeline>")
  .description("Show one pipeline: provenance, job DAG with live run states, and GitHub check state. Accepts a pipeline id or its parent run id.")
  .action(async (pipeline) => {
    const data = await client(program.opts()).get(`/api/ci/pipelines/${encodeURIComponent(pipeline)}`);
    if (program.opts().json) return print(data, true);
    for (const line of renderCiPipeline(data)) console.log(line);
  });
ciCommand
  .command("cancel <pipeline>")
  .description("Cancel a pipeline: parent run + dispatched job runs are cancelled, pending jobs never start")
  .action(async (pipeline) => {
    const data = await client(program.opts()).post(`/api/ci/pipelines/${encodeURIComponent(pipeline)}/cancel`, {});
    if (program.opts().json) return print(data, true);
    for (const line of renderCiPipeline(data)) console.log(line);
  });
ciCommand
  .command("rerun <pipeline>")
  .description("Rerun a pipeline as a fresh pipeline against the same SHAs (the original stays as evidence)")
  .action(async (pipeline) => {
    const data = await client(program.opts()).post(`/api/ci/pipelines/${encodeURIComponent(pipeline)}/rerun`, {});
    if (program.opts().json) return print(data, true);
    for (const line of renderCiPipeline(data)) console.log(line);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
