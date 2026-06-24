#!/usr/bin/env node
// Smithers Hub runner — executes real Smithers workflows.
//
// A "capability" is a Smithers workflow file in a local .smithers workspace. This runner claims
// queued runs from the Hub, executes `smithers up <workflow> --input <json> -d` (which spawns the
// local Claude Code / Codex CLI as the worker), streams Smithers events back to the Hub as run
// events, and uploads the workflow's outputs + event trace as artifacts. Nothing is faked: the
// agent runs here, on this machine, and the Hub is the durable record.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HubClient } from "./apiClient.js";
import { markdownArtifactsFromOutputs } from "./runnerArtifacts.js";
import { normalizeRunnerTags } from "./runExecution.js";
import { extractSmithersFailure } from "./smithersFailure.js";
import { supportWarmEnabled, warmSupportReply } from "./supportWarm.js";
import { collectAuthHealth } from "./runnerAuthHealth.js";
import { reauthEnabled, runReauth } from "./reauthCli.js";
import { isDraining, resolveDataDir } from "./drain.js";

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
const exitAfterRuns = Math.max(0, Math.floor(Number(process.env.SMITHERS_RUNNER_EXIT_AFTER_RUNS || 0)));

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

// Persist the Hub-assigned runner id across restarts so a normal service bounce
// reuses one stable row instead of minting a ghost. Server-side stable-identity
// matching (token+name+hostname) is the primary defense; this id-file is the
// fast path. A missing/corrupt file is tolerated — we simply re-register and
// re-cache whatever id the Hub hands back.
const runnerIdFile = path.join(workspace, ".smithers", "runner-id");

function loadCachedRunnerId() {
  try {
    return readFileSync(runnerIdFile, "utf8").trim() || "";
  } catch {
    return "";
  }
}

function cacheRunnerId(value) {
  if (!value) return;
  try {
    mkdirSync(path.dirname(runnerIdFile), { recursive: true });
    writeFileSync(runnerIdFile, `${value}\n`);
  } catch (error) {
    console.error("failed to persist runner id:", error.message);
  }
}

let runnerId = process.env.SMITHERS_RUNNER_ID || loadCachedRunnerId() || "";
// Active run IDs the runner is currently executing. Capacity is checked
// against this set instead of a single `busy` flag so multiple runs can
// progress in parallel.
const activeRuns = new Set();
let completedRuns = 0;
let intervalHandle = null;
// Where the updater writes the drain flag (the shared Hub dataDir). Resolved the
// same way the Hub resolves it so a single-box install agrees without extra config.
const drainDataDir = resolveDataDir();
let drainLogged = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => String(s).replace(/\[[0-9;]*m/g, "");

async function smithers(args, opts = {}) {
  return execFileAsync("smithers", args, {
    cwd: workspace,
    timeout: opts.timeout || 60_000,
    maxBuffer: 1024 * 1024 * 32,
    ...(opts.env ? { env: opts.env } : {})
  });
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
  cacheRunnerId(runnerId);
  console.log(
    `Registered Smithers runner ${runnerId} (${name}) tags=[${tags}] workspace=${workspace} capacity=${concurrency}`
  );
}

// Launch `smithers up` detached and return the Smithers runId. `secretEnv` is
// the allowlisted, decrypted secrets the Hub injected with this run's claim;
// they are merged into the child process env so the workflow's agent can use
// them, and never written to disk/inputs/logs.
async function launch(entry, input, secretEnv = {}) {
  const workflowPath = path.isAbsolute(entry) ? entry : path.join(workspace, entry);
  const { stdout } = await smithers(["up", workflowPath, "--input", JSON.stringify(input || {}), "-d", "--format", "json"], {
    env: { ...process.env, ...secretEnv }
  });
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

function runSmithersSupervisionFailure(capability, outputs) {
  if (capability?.slug !== "run-smithers") return "";
  const outcome = outputs?.supervise?.outcome;
  if (!outcome || outcome === "succeeded") return "";
  const summary = outputs?.supervise?.summary || "";
  return `run-smithers ended with outcome '${outcome}'${summary ? `: ${summary}` : ""}`;
}

async function executeAssignment(assignment) {
  const { run, capability } = assignment;
  // Allowlisted, decrypted secrets the Hub injected for this run (never stored).
  const secretEnv = assignment.secretEnv && typeof assignment.secretEnv === "object" ? assignment.secretEnv : {};
  const entry = capability.workflow?.entry || capability.workflow?.file;
  activeRuns.add(run.id);
  try {
    await client.post(`/api/runs/${run.id}/start`, {});

    // Re-auth special path (dedicated runner host only, gated by REAUTH_ENABLED).
    // Drives `codex login --device-auth` / `claude setup-token` on THIS host and
    // streams the verification URL + user code back as run output so the Hub UI
    // can show them. Mirrors the supportWarm special-path pattern; the general
    // runner pool never sets REAUTH_ENABLED, so this branch is inert there.
    if (reauthEnabled() && capability.slug === "reauth-cli") {
      await event(run.id, "runner.reauth", `Starting CLI re-auth on ${name}`, { runnerId, provider: run.input?.provider });
      const reauth = await runReauth(run.input || {}, {
        onVerification: (info) =>
          client
            .post(`/api/runs/${run.id}/events`, {
              type: "reauth.verification",
              message: `Open ${info.verificationUrl} and enter code ${info.userCode}`,
              data: { reauth: info }
            })
            .catch(() => {})
      });
      if (reauth.status === "ok") {
        await client.post(`/api/runs/${run.id}/complete`, { output: { outputs: { reauth } } });
        console.log(`Completed ${run.id} via reauth (${reauth.provider})`);
      } else {
        await client.post(`/api/runs/${run.id}/fail`, { error: reauth.error || `reauth ${reauth.status}` });
        console.log(`Run ${run.id} reauth ended '${reauth.status}'`);
      }
      return;
    }

    // Warm support path (dedicated support-runner only, gated by SUPPORT_WARM).
    // Answer the support-chat capability directly via the local `claude` CLI
    // instead of a full `smithers up`, completing the run with the same
    // { outputs.support.reply } shape the Hub already reads. The general runner
    // pool never sets SUPPORT_WARM, so this branch is inert there.
    if (supportWarmEnabled() && capability.slug === "runyard-support-agent") {
      await event(run.id, "runner.warm_support", `Answering support chat via warm claude on ${name}`, { runnerId });
      const reply = await warmSupportReply(run.input || {});
      await client.post(`/api/runs/${run.id}/complete`, { output: { outputs: { support: { reply } } } });
      console.log(`Completed ${run.id} via warm support`);
      return;
    }

    if (!entry) throw new Error(`capability ${capability.slug} has no workflow.entry`);
    await event(run.id, "runner.started", `Executing Smithers workflow ${entry} on ${name}`, { runnerId, entry, location });

    const sid = await launch(entry, run.input, secretEnv);
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

    const supervisionFailure = state === "succeeded" ? runSmithersSupervisionFailure(capability, outputs) : "";
    if (state === "succeeded" && !supervisionFailure) {
      await client.post(`/api/runs/${run.id}/complete`, { output: { smithersRunId: sid, outputs } });
      console.log(`Completed ${run.id} via smithers ${sid}`);
    } else {
      let error;
      if (supervisionFailure) {
        error = supervisionFailure;
      } else if (deadlineExceeded) {
        error = `smithers run ${sid} exceeded runner deadline (${maxRunMs}ms) and was cancelled`;
      } else {
        // Surface the real failing-node error/stack (e.g. a TypeError in a
        // workflow template) instead of the opaque state message, so the
        // supervising watcher can recognise a deterministic workflow-code
        // failure and decide whether a one-shot repair is warranted.
        const failure = extractSmithersFailure(st, eventLines);
        error = failure.error
          ? `smithers run ${sid} failed${failure.failedStep ? ` at node '${failure.failedStep}'` : ""}: ${failure.error}`.slice(0, 2000)
          : `smithers run ${sid} ended in state '${state}'`;
      }
      await client.post(`/api/runs/${run.id}/fail`, { error });
      console.log(`Run ${run.id} ended '${state}' (smithers ${sid})`);
    }
  } catch (error) {
    await client.post(`/api/runs/${run.id}/fail`, { error: error.stack || error.message }).catch(() => {});
    console.error(`Run ${run.id} failed:`, error.message);
  } finally {
    activeRuns.delete(run.id);
    completedRuns += 1;
    maybeExitAfterRuns();
  }
}

// Auth health is read from disk and attached to the heartbeat. Refreshing it on
// every 2.5s tick would hammer the filesystem, so cache it and re-read at most
// once per AUTH_HEALTH_TTL_MS. Booleans + expiry + account id only — never token
// material (see src/runnerAuthHealth.js).
const AUTH_HEALTH_TTL_MS = Number(process.env.SMITHERS_AUTH_HEALTH_TTL_MS || 30_000);
let authHealthCache = null;
let authHealthCheckedAtMs = 0;
function currentAuthHealth() {
  const nowMs = Date.now();
  if (!authHealthCache || nowMs - authHealthCheckedAtMs > AUTH_HEALTH_TTL_MS) {
    try {
      authHealthCache = collectAuthHealth({ now: nowMs });
    } catch {
      authHealthCache = null;
    }
    authHealthCheckedAtMs = nowMs;
  }
  return authHealthCache;
}

let tickInFlight = false;
function maybeExitAfterRuns() {
  if (!exitAfterRuns || completedRuns < exitAfterRuns || activeRuns.size > 0) return;
  if (intervalHandle) clearInterval(intervalHandle);
  console.log(`Smithers runner exiting after ${completedRuns} completed run(s).`);
  process.exit(0);
}

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
        currentRunId: activeRuns.size ? [...activeRuns][0] : null,
        auth: currentAuthHealth()
      })
      .catch(() => {});
    // Drain gate: during an operator-initiated `runyard update` the updater
    // writes a .drain flag under the shared Hub dataDir. While it is present we
    // STOP claiming new work but keep heartbeating and finishing in-flight runs
    // — a mid-run restart would destroy the agent's work, so we let it complete.
    if (isDraining(drainDataDir)) {
      if (!drainLogged) {
        console.log("Drain flag set — pausing claims; finishing in-flight runs only.");
        drainLogged = true;
      }
    } else {
      if (drainLogged) {
        console.log("Drain flag cleared — resuming claims.");
        drainLogged = false;
      }
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
    }
    maybeExitAfterRuns();
  } finally {
    tickInFlight = false;
  }
}

async function main() {
  await register();
  await tick();
  intervalHandle = setInterval(() => tick().catch((e) => console.error("tick failed:", e.message)), intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
