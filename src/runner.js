#!/usr/bin/env node
// RunYard runner — executes real Smithers workflows.
//
// A "capability" is a Smithers workflow file in a local .smithers workspace. This runner claims
// queued runs from the Hub, executes `smithers up <workflow> --input <json> -d` (which spawns the
// local Claude Code / Codex CLI as the worker), streams Smithers events back to the Hub as run
// events, and uploads the workflow's outputs + event trace as artifacts. Nothing is faked: the
// agent runs here, on this machine, and the Hub is the durable record.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HubClient } from "./apiClient.js";
import { normalizeRunnerTags } from "./runExecution.js";
import { collectAuthHealth } from "./runnerAuthHealth.js";
import { classifyFailureStatus, RUN_FAILURE_CLASSES } from "./runFailureClass.js";
import { DEFAULT_MAX_INLINE_INPUT_BYTES } from "./runnerPolicy.js";
import { smithersEventMessage } from "./runnerSmithersEvents.js";
import { readClaudeOauthToken } from "./claudeOauthToken.js";
import { isDraining, resolveDataDir } from "./drain.js";
import { resolveSmithersBin, resolveExecWrapper } from "./resolveSmithersBin.js";
import {
  createSmithersRunRegistry,
  isHubTerminalStatus,
  launchSmithers,
  smithersCommand
} from "./runnerSmithersRuntime.js";
import {
  collectSmithersRunResult,
  smithersArtifactPayloads
} from "./runnerSmithersArtifacts.js";
import { smithersRunOutcome } from "./runnerSmithersOutcome.js";
import {
  createClaimAuthTracker,
  isAuthError
} from "./runnerClaimAuth.js";
import {
  activeRunnerLoad as computeActiveRunnerLoad,
  hasClaimCapacity as computeHasClaimCapacity,
  isSupervisorCapability,
  materializeAgentRuntimePack as writeAgentRuntimePack,
  preflightAssignment
} from "./runnerRuntime.js";
import { handleRunnerSpecialRun } from "./runnerSpecialRuns.js";

const execFileAsync = promisify(execFile);

// Resolve once at startup: env override → pinned bun global install → PATH.
// Keeps the pinned smithers-orchestrator engine deterministic on dstack images.
const smithersBin = resolveSmithersBin();
// Unopinionated execution seam: empty = run the engine directly on the host
// (default); set RUNNER_EXEC_WRAPPER to run each engine invocation through a
// deployer-chosen sandbox/container/job launcher. See resolveExecWrapper().
const execWrapper = resolveExecWrapper();

const baseUrl =
  process.env.RUNYARD_HUB_URL || process.env.SMITHERS_HUB_URL || process.env.HUB_URL || "http://127.0.0.1:43117";
const token =
  process.env.RUNYARD_HUB_TOKEN ||
  process.env.SMITHERS_HUB_TOKEN ||
  process.env.HUB_TOKEN ||
  process.env.RUNYARD_HUB_BOOTSTRAP_TOKEN ||
  process.env.SMITHERS_HUB_BOOTSTRAP_TOKEN;
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
  console.error("RUNYARD_HUB_TOKEN is required for the runner.");
  process.exit(1);
}

const client = new HubClient({ baseUrl, token });
let shuttingDown = false;

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
const activeRunKinds = new Map();
let completedRuns = 0;
let intervalHandle = null;
const claimAuth = createClaimAuthTracker({ baseUrl });

function activeRunnerLoad() {
  return computeActiveRunnerLoad(activeRunKinds);
}

function hasClaimCapacity() {
  return computeHasClaimCapacity(activeRunKinds, concurrency, process.env.SMITHERS_SUPERVISOR_SLOT_RATIO || 1);
}

// Startup self-check: prove the configured token actually authenticates AND can
// reach the claim path against the configured hub before we sit in a polling
// loop. A 200 (even "no work") confirms the runner is wired correctly; a 401/403
// means a silent-misconfig runner — fail loudly so an operator notices.
async function verifyHubAuth() {
  if (!runnerId) return false;
  try {
    const assignment = await client.get(`/api/runners/${runnerId}/next-run`);
    claimAuth.record(true);
    console.log(`Hub auth self-check OK against ${baseUrl} (token + claim path verified).`);
    // The probe uses the REAL claim path (a 401/403 fires in auth middleware
    // before any claim). If work happened to be queued it actually claimed a
    // run — execute it rather than orphaning the assignment, which would leak a
    // slot until the reaper releases it.
    if (assignment?.run) {
      executeAssignment(assignment).catch((error) => console.error("executeAssignment failed:", error.message));
    }
    return true;
  } catch (error) {
    if (isAuthError(error)) {
      claimAuth.record(false, error);
      return false;
    }
    // Network/transient: warn but don't hard-fail; the poll loop will retry.
    console.error(`Hub auth self-check could not reach ${baseUrl}: ${error.message}`);
    return false;
  }
}
// Where the updater writes the drain flag (the shared Hub dataDir). Resolved the
// same way the Hub resolves it so a single-box install agrees without extra config.
const drainDataDir = resolveDataDir();
let drainLogged = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_INLINE_INPUT_BYTES = Number(process.env.RUNYARD_MAX_INLINE_INPUT_BYTES || DEFAULT_MAX_INLINE_INPUT_BYTES);

async function failRun(runId, error, status = "") {
  const failureStatus = status || classifyFailureStatus(error);
  return client.post(`/api/runs/${runId}/fail`, { error, status: failureStatus });
}

function materializeAgentRuntimePack(run, pack) {
  return writeAgentRuntimePack(run, pack, { workspace });
}

async function smithers(args, opts = {}) {
  // Prepend the deployer-configured exec wrapper, if any:
  //   wrapper set  -> `<wrapper[0]> <wrapper[1..]> <smithersBin> <args>`
  //   wrapper unset -> `<smithersBin> <args>` (bare host default)
  const command = smithersCommand({ smithersBin, execWrapper }, args);
  if (!opts.stdin) {
    return execFileAsync(command.cmd, command.args, {
      cwd: workspace,
      timeout: opts.timeout || 60_000,
      maxBuffer: 1024 * 1024 * 32,
      ...(opts.env ? { env: opts.env } : {})
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, command.args, {
      cwd: workspace,
      env: opts.env || process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(`smithers timed out after ${opts.timeout || 60_000}ms`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, opts.timeout || 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(stderr || stdout || `smithers exited ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.stdin.end(opts.stdin);
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

const smithersRegistry = createSmithersRunRegistry({
  cancelSmithersRun,
  event,
  logError: console.error
});

async function observedHubRunStatus(runId) {
  try {
    return (await client.get(`/api/runs/${runId}`))?.run?.status || "";
  } catch {
    return "";
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
    `Registered Smithers runner ${runnerId} (${name}) tags=[${tags}] workspace=${workspace} capacity=${concurrency} smithers=${smithersBin}${execWrapper.length ? ` exec-wrapper=[${execWrapper.join(" ")}]` : ""}`
  );
}

// Launch `smithers up` detached and return the Smithers runId. `secretEnv` is
// the allowlisted, decrypted secrets the Hub injected with this run's claim;
// they are merged into the child process env so the workflow's agent can use
// them, and never written to disk/inputs/logs.
async function launch(entry, input, secretEnv = {}, resume = null, hubRunId = "") {
  const claudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || readClaudeOauthToken();
  const runEnv = {
    RUNYARD_RUN_ID: String(hubRunId || ""),
    SMITHERS_HUB_RUN_ID: String(hubRunId || "")
  };
  return launchSmithers({
    runSmithers: smithers,
    entry,
    input,
    secretEnv,
    resume,
    workspace,
    token,
    baseUrl,
    maxInlineInputBytes: MAX_INLINE_INPUT_BYTES,
    claudeOauthToken,
    runEnv
  });
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
  // Allowlisted, decrypted secrets the Hub injected for this run (never stored).
  const secretEnv = assignment.secretEnv && typeof assignment.secretEnv === "object" ? assignment.secretEnv : {};
  const entry = capability.workflow?.entry || capability.workflow?.file;
  activeRuns.add(run.id);
  activeRunKinds.set(run.id, isSupervisorCapability(capability) ? "supervisor" : "work");
  try {
    await client.post(`/api/runs/${run.id}/start`, {});

    const handledSpecialRun = await handleRunnerSpecialRun({
      capability,
      run,
      secretEnv,
      runnerName: name,
      runnerId,
      client,
      event,
      failRun
    });
    if (handledSpecialRun) return;

    const preflightFailures = preflightAssignment(run, capability, entry, {
      workspace,
      health: currentAuthHealth(),
      env: process.env
    });
    if (preflightFailures.length) {
      const error = `preflight failed: ${preflightFailures.join("; ")}`;
      await event(run.id, "runner.preflight_failed", error, {
        runnerId,
        failureClass: RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT
      });
      await failRun(run.id, error, RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT);
      console.log(`Run ${run.id} blocked by preflight: ${preflightFailures.join("; ")}`);
      return;
    }
    await event(run.id, "runner.started", `Executing Smithers workflow ${entry} on ${name}`, { runnerId, entry, location });

    // A hub-supervised resume carries the prior Smithers run id in __resume.
    const resume = run.input && typeof run.input === "object" ? run.input.__resume : null;
    const runtimeEnv = materializeAgentRuntimePack(run, assignment.agentRuntimePack);
    const sid = await launch(entry, run.input, { ...runtimeEnv, ...secretEnv }, resume, run.id);
    smithersRegistry.register(run.id, sid);
    if (resume?.smithersRunId) {
      await event(run.id, "runner.resumed", `Resuming Smithers run ${sid} from checkpoint (attempt ${resume.attempt || "?"})`, {
        smithersRunId: sid,
        resumedFrom: resume.smithersRunId,
        attempt: resume.attempt || null
      });
    }
    await event(run.id, "smithers.dispatched", `Smithers run ${sid} started`, { smithersRunId: sid });

    // Stream Smithers events to the Hub until the run reaches a terminal state.
    let posted = 0;
    let state = "running";
    const deadline = Date.now() + maxRunMs;
    let deadlineExceeded = false;
    let hubTerminalStatus = "";
    while (Date.now() < deadline) {
      const lines = await fetchEvents(sid);
      for (let i = posted; i < lines.length; i++) {
        await event(run.id, "smithers.event", smithersEventMessage(lines[i]));
      }
      posted = lines.length;
      try {
        const st = await getState(sid);
        state = st.runState?.state || st.run?.status || "running";
      } catch {
        /* keep polling */
      }
      hubTerminalStatus = await observedHubRunStatus(run.id);
      if (isHubTerminalStatus(hubTerminalStatus)) {
        await event(
          run.id,
          "runner.hub_terminal_observed",
          `Hub marked run terminal as '${hubTerminalStatus}'; cancelling owned Smithers run ${sid}.`,
          { smithersRunId: sid, status: hubTerminalStatus }
        );
        await cancelSmithersRun(sid, `hub terminal status: ${hubTerminalStatus}`);
        state = "cancelled";
        break;
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

    if (isHubTerminalStatus(hubTerminalStatus)) {
      console.log(`Run ${run.id} stopped locally because Hub is already '${hubTerminalStatus}' (smithers ${sid})`);
      return;
    }

    const {
      inspect: st,
      outputs,
      eventLines
    } = await collectSmithersRunResult(sid, { getState, nodeOutput, fetchEvents });
    for (const artifact of smithersArtifactPayloads({ sid, state, outputs, eventLines })) {
      await client.post(`/api/runs/${run.id}/artifacts`, artifact);
    }

    const outcome = smithersRunOutcome({
      capability,
      state,
      sid,
      outputs,
      inspect: st,
      eventLines,
      deadlineExceeded,
      maxRunMs
    });
    if (outcome.ok) {
      await client.post(`/api/runs/${run.id}/complete`, { output: outcome.output });
      console.log(`Completed ${run.id} via smithers ${sid}`);
    } else {
      await failRun(run.id, outcome.error, outcome.status);
      console.log(`Run ${run.id} ended '${state}' (smithers ${sid})`);
    }
  } catch (error) {
    await failRun(run.id, error.stack || error.message).catch(() => {});
    console.error(`Run ${run.id} failed:`, error.message);
  } finally {
    smithersRegistry.unregister(run.id);
    activeRuns.delete(run.id);
    activeRunKinds.delete(run.id);
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
  // Ride the hub claim-auth status along on every heartbeat so the dashboard can
  // surface "online but can't claim" instead of a healthy-looking dead runner.
  const base = authHealthCache && typeof authHealthCache === "object" ? { ...authHealthCache } : {};
  base.hub = claimAuth.health();
  return base;
}

let tickInFlight = false;
function maybeExitAfterRuns() {
  if (!exitAfterRuns || completedRuns < exitAfterRuns || activeRuns.size > 0) return;
  if (intervalHandle) clearInterval(intervalHandle);
  console.log(`Smithers runner exiting after ${completedRuns} completed run(s).`);
  process.exit(0);
}

async function tick() {
  if (!runnerId || shuttingDown) return;
  // setInterval doesn't wait for the previous tick to finish — guard against
  // two overlapping pollers racing each other to claim the same slot.
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    // Heartbeat first so the Hub UI sees the capacity / active-slot update
    // even on a tick where we have no spare capacity to claim more work.
    const load = activeRunnerLoad();
    await client
      .post(`/api/runners/${runnerId}/heartbeat`, {
        tags,
        capacity: concurrency,
        activeRuns: load.work + load.supervisors,
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
      while (hasClaimCapacity()) {
        let assignment;
        try {
          assignment = await client.get(`/api/runners/${runnerId}/next-run`);
          claimAuth.record(true);
        } catch (error) {
          // A 401/403 is a config fault, not "no work" — surface it loudly via
          // recordClaimAuth (logs + heartbeat) instead of silently swallowing.
          if (isAuthError(error)) claimAuth.record(false, error);
          break;
        }
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

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (intervalHandle) clearInterval(intervalHandle);
  console.log(`${signal} received; cancelling ${smithersRegistry.active.size} owned Smithers run(s) before exit.`);
  try {
    await smithersRegistry.cancelAll(`runner received ${signal}`);
  } finally {
    process.exit(0);
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM").catch((error) => {
  console.error("shutdown failed:", error.message);
  process.exit(1);
}));
process.once("SIGINT", () => shutdown("SIGINT").catch((error) => {
  console.error("shutdown failed:", error.message);
  process.exit(1);
}));

async function main() {
  try {
    await register();
  } catch (error) {
    // A dead token / wrong hub URL fails registration with 401/403. Route it
    // through the loud auth banner and exit non-zero so systemd surfaces (and
    // restarts) a misconfigured runner instead of leaving a silent ghost.
    if (isAuthError(error)) {
      claimAuth.record(false, error);
      process.exit(1);
    }
    throw error;
  }
  // Prove auth + claim path before entering the poll loop. A failure is logged
  // loudly (recordClaimAuth) but non-fatal — the runner keeps retrying and the
  // heartbeat reports auth.hub.ok=false so the misconfig is visible immediately.
  await verifyHubAuth();
  await tick();
  intervalHandle = setInterval(() => tick().catch((e) => console.error("tick failed:", e.message)), intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
