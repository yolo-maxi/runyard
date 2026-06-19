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
import { normalizeRunnerTags } from "./runExecution.js";

const execFileAsync = promisify(execFile);

const baseUrl = process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117";
const token = process.env.SMITHERS_HUB_TOKEN || process.env.HUB_TOKEN || process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN;
const workspace = path.resolve(process.env.SMITHERS_WORKSPACE || process.cwd());
const location = process.env.SMITHERS_RUNNER_LOCATION || "vps"; // "vps" | "local"
const name = process.env.SMITHERS_RUNNER_NAME || `${os.hostname()} (${location})`;
const tags = normalizeRunnerTags(
  (process.env.SMITHERS_RUNNER_TAGS || `smithers,${location}`)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
  location
);
const intervalMs = Number(process.env.SMITHERS_RUNNER_INTERVAL_MS || 2500);
const pollMs = Number(process.env.SMITHERS_POLL_MS || 2000);
const maxRunMs = Number(process.env.SMITHERS_MAX_RUN_MS || 2 * 60 * 60_000);

// Concurrency controls how many Smithers runs this single runner process
// may execute in parallel. Defaults to 1 to keep existing single-runner
// deployments behaving exactly as before. A VPS pool host can set
// SMITHERS_RUNNER_CONCURRENCY=4 for a safe target of ~4 concurrent jobs.
// The cap (16) is a defense against typos like "40" overloading the box.
const concurrency = Math.max(
  1,
  Math.min(16, Math.floor(Number(process.env.SMITHERS_RUNNER_CONCURRENCY || 1)))
);

if (!token) {
  console.error("SMITHERS_HUB_TOKEN is required for the runner.");
  process.exit(1);
}

const client = new HubClient({ baseUrl, token });
let runnerId = process.env.SMITHERS_RUNNER_ID || "";
// Active run IDs the runner is currently executing. Capacity is checked
// against this set instead of a single `busy` flag so multiple runs can
// progress in parallel.
const activeRuns = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, "");

async function smithers(args, opts = {}) {
  return execFileAsync("smithers", args, { cwd: workspace, timeout: opts.timeout || 60_000, maxBuffer: 1024 * 1024 * 32 });
}

async function cancelSmithersRun(sid, reason = "") {
  if (!sid) return false;
  try {
    await smithers(["cancel", sid], { timeout: 30_000 });
    return true;
  } catch (error) {
    console.error(`failed to cancel Smithers run ${sid}:`, error.message);
    return false;
  }
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
    tags,
    capacity: concurrency
  });
  runnerId = res.runner.id;
  console.log(
    `Registered Smithers runner ${runnerId} (${name}) tags=[${tags}] workspace=${workspace} capacity=${concurrency}`
  );
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
  activeRuns.add(run.id);
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
    let deadlineExceeded = false;
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

    if (!TERMINAL.has(state)) {
      deadlineExceeded = true;
      await event(
        run.id,
        "runner.deadline_exceeded",
        `Smithers run ${sid} exceeded runner deadline after ${maxRunMs}ms; cancelling detached workflow.`,
        { smithersRunId: sid, maxRunMs }
      );
      await cancelSmithersRun(sid, "runner deadline exceeded");
      state = "cancelled";
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
      const error = deadlineExceeded
        ? `smithers run ${sid} exceeded runner deadline (${maxRunMs}ms) and was cancelled`
        : `smithers run ${sid} ended in state '${state}'`;
      await client.post(`/api/runs/${run.id}/fail`, { error });
      console.log(`Run ${run.id} ended '${state}' (smithers ${sid})`);
    }
  } catch (error) {
    await client.post(`/api/runs/${run.id}/fail`, { error: error.stack || error.message }).catch(() => {});
    console.error(`Run ${run.id} failed:`, error.message);
  } finally {
    activeRuns.delete(run.id);
  }
}

let tickInFlight = false;
async function tick() {
  if (!runnerId) return;
  // setInterval doesn't wait for the previous tick to finish — guard against
  // two overlapping pollers racing each other to claim the same slot.
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    // Heartbeat first so the Hub UI sees the capacity / active-slot update
    // even on a tick where we have no spare capacity to claim more work.
    await client
      .post(`/api/runners/${runnerId}/heartbeat`, {
        tags,
        capacity: concurrency,
        activeRuns: activeRuns.size,
        currentRunId: activeRuns.size ? [...activeRuns][0] : null
      })
      .catch(() => {});
    // Fill every empty slot in this tick so a fast-arriving backlog drains as
    // quickly as the runner can poll. Each executeAssignment runs as its own
    // async task; we don't await them so multiple runs progress concurrently.
    while (activeRuns.size < concurrency) {
      const assignment = await client.get(`/api/runners/${runnerId}/next-run`).catch(() => ({}));
      if (!assignment?.run) break;
      // Fire-and-forget — executeAssignment manages the activeRuns slot in
      // its own try/finally so an unexpected throw can't leak a slot.
      executeAssignment(assignment).catch((error) => console.error("executeAssignment failed:", error.message));
    }
  } finally {
    tickInFlight = false;
  }
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
