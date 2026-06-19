#!/usr/bin/env node
// Smithers Hub runner — executes real Smithers workflows.
//
// A "capability" is a Smithers workflow file in a local .smithers workspace. This runner claims
// queued runs from the Hub, executes `smithers up <workflow> --input <json> -d` (which spawns the
// local Claude Code / Codex CLI as the worker), streams Smithers events back to the Hub as run
// events, and uploads the workflow's outputs + event trace as artifacts. Nothing is faked: the
// agent runs here, on this machine, and the Hub is the durable record.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HubClient } from "./apiClient.js";
import { markdownArtifactsFromOutputs } from "./runnerArtifacts.js";

const execFileAsync = promisify(execFile);

const baseUrl = process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117";
const token = process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN || process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN;
const workspace = path.resolve(process.env.SMITHERS_WORKSPACE || process.cwd());
const location = process.env.SMITHERS_RUNNER_LOCATION || "vps"; // "vps" | "local"
const name = process.env.SMITHERS_RUNNER_NAME || `${os.hostname()} (${location})`;
const tags = (process.env.SMITHERS_RUNNER_TAGS || `smithers,${location}`)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const intervalMs = Number(process.env.SMITHERS_RUNNER_INTERVAL_MS || 2500);
const pollMs = Number(process.env.SMITHERS_POLL_MS || 2000);
const maxRunMs = Number(process.env.SMITHERS_MAX_RUN_MS || 30 * 60_000);

if (!token) {
  console.error("SMITHERS_HUB_TOKEN is required for the runner.");
  process.exit(1);
}

const client = new HubClient({ baseUrl, token });
let runnerId = process.env.SMITHERS_RUNNER_ID || "";
let busy = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, "");

async function smithers(args, opts = {}) {
  return execFileAsync("smithers", args, { cwd: workspace, timeout: opts.timeout || 60_000, maxBuffer: 1024 * 1024 * 32 });
}

async function event(runId, type, message, data = {}) {
  try {
    await client.post(`/api/runs/${runId}/events`, { type, message: String(message).slice(0, 4000), data });
  } catch (error) {
    console.error("event post failed:", error.message);
  }
}

async function register() {
  const res = await client.post("/api/runners/register", {
    id: runnerId || undefined,
    name,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    version: "0.2.0",
    tags
  });
  runnerId = res.runner.id;
  console.log(`Registered Smithers runner ${runnerId} (${name}) tags=[${tags}] workspace=${workspace}`);
}

// Launch `smithers up` detached and return the Smithers runId.
async function launch(entry, input) {
  const workflowPath = path.isAbsolute(entry) ? entry : path.join(workspace, entry);
  const { stdout } = await smithers(["up", workflowPath, "--input", JSON.stringify(input || {}), "-d", "--format", "json"]);
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.runId) return parsed.runId;
  } catch {
    /* fall through to regex */
  }
  const m = stdout.match(/run-\d+/);
  if (!m) throw new Error(`could not determine smithers runId from: ${stdout.slice(0, 200)}`);
  return m[0];
}

async function fetchEvents(sid) {
  try {
    const { stdout } = await smithers(["events", sid, "--json", "--limit", "100000"]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function getState(sid) {
  const { stdout } = await smithers(["inspect", sid, "--format", "json"]);
  return JSON.parse(stdout);
}

async function nodeOutput(sid, nodeId) {
  try {
    const { stdout } = await smithers(["output", sid, nodeId, "--json"]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "errored"]);

async function executeAssignment(assignment) {
  const { run, capability } = assignment;
  const entry = capability.workflow?.entry || capability.workflow?.file;
  busy = true;
  try {
    await client.post(`/api/runs/${run.id}/start`, {});
    if (!entry) throw new Error(`capability ${capability.slug} has no workflow.entry`);
    await event(run.id, "runner.started", `Executing Smithers workflow ${entry} on ${name}`, { runnerId, entry, location });

    const sid = await launch(entry, run.input);
    await event(run.id, "smithers.dispatched", `Smithers run ${sid} started`, { smithersRunId: sid });

    // Stream Smithers events to the Hub until the run reaches a terminal state.
    let posted = 0;
    let state = "running";
    const deadline = Date.now() + maxRunMs;
    while (Date.now() < deadline) {
      const lines = await fetchEvents(sid);
      for (let i = posted; i < lines.length; i++) {
        let msg = lines[i];
        try {
          const obj = JSON.parse(lines[i]);
          msg = obj.data ?? obj.message ?? lines[i];
        } catch {
          /* keep raw */
        }
        await event(run.id, "smithers.event", stripAnsi(msg));
      }
      posted = lines.length;
      try {
        const st = await getState(sid);
        state = st.runState?.state || st.run?.status || "running";
      } catch {
        /* keep polling */
      }
      if (TERMINAL.has(state)) break;
      await sleep(pollMs);
    }

    // Collect outputs per node + the full event trace, upload as artifacts.
    const st = await getState(sid);
    const steps = st.steps || [];
    const outputs = {};
    for (const step of steps) {
      const out = await nodeOutput(sid, step.id);
      if (out !== null) outputs[step.id] = out;
    }
    const eventLines = await fetchEvents(sid);
    await client.post(`/api/runs/${run.id}/artifacts`, {
      name: "smithers-output.json",
      mimeType: "application/json",
      content: JSON.stringify({ smithersRunId: sid, state, outputs }, null, 2)
    });
    for (const artifact of markdownArtifactsFromOutputs(outputs)) {
      await client.post(`/api/runs/${run.id}/artifacts`, artifact);
    }
    await client.post(`/api/runs/${run.id}/artifacts`, {
      name: "smithers-events.ndjson",
      mimeType: "application/x-ndjson",
      content: eventLines
        .map((l) => {
          try {
            return stripAnsi(JSON.parse(l).data ?? l);
          } catch {
            return l;
          }
        })
        .join("\n")
    });

    if (state === "succeeded") {
      await client.post(`/api/runs/${run.id}/complete`, { output: { smithersRunId: sid, outputs } });
      console.log(`Completed ${run.id} via smithers ${sid}`);
    } else {
      await client.post(`/api/runs/${run.id}/fail`, { error: `smithers run ${sid} ended in state '${state}'` });
      console.log(`Run ${run.id} ended '${state}' (smithers ${sid})`);
    }
  } catch (error) {
    await client.post(`/api/runs/${run.id}/fail`, { error: error.stack || error.message }).catch(() => {});
    console.error(`Run ${run.id} failed:`, error.message);
  } finally {
    busy = false;
  }
}

async function tick() {
  if (!runnerId || busy) return;
  await client.post(`/api/runners/${runnerId}/heartbeat`, { tags, currentRunId: busy ? "busy" : null }).catch(() => {});
  const assignment = await client.get(`/api/runners/${runnerId}/next-run`).catch(() => ({}));
  if (assignment?.run) await executeAssignment(assignment);
}

async function main() {
  await register();
  await tick();
  setInterval(() => tick().catch((e) => console.error("tick failed:", e.message)), intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
