#!/usr/bin/env node
// RunYard runner — executes real Smithers workflows.
//
// A workflow is a Smithers file in a local .smithers workspace. This runner claims
// queued runs from the Hub, executes `smithers up <workflow> --input <json> -d` (which spawns the
// local Claude Code / Codex CLI as the worker), streams Smithers events back to the Hub as run
// events, and uploads the workflow's outputs + event trace as artifacts. Nothing is faked: the
// agent runs here, on this machine, and the Hub is the durable record.
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HubClient } from "./apiClient.js";
import { normalizeRunnerTags } from "./runExecution.js";
import { collectAuthHealth } from "./runnerAuthHealth.js";
import { classifyFailureStatus, RUN_FAILURE_CLASSES } from "./runFailureClass.js";
import { classifyPauseReason, PAUSE_REASONS } from "./runPause.js";
import { DEFAULT_MAX_INLINE_INPUT_BYTES } from "./runnerPolicy.js";
import { createFollowerLineHandler } from "./runnerSmithersEvents.js";
import { materializeGatewayPin } from "./runnerGateway.js";
import { createEngineApprovalBridge } from "./runnerEngineApprovals.js";
import { readClaudeOauthToken } from "./claudeOauthToken.js";
import { isDraining, resolveDataDir } from "./drain.js";
import { resolveHubUrl, resolveHubToken } from "./hubConnection.js";
import { packageVersion, pinnedSmithersVersion } from "./packageInfo.js";
import { resolveSmithersBin } from "./resolveSmithersBin.js";
import { resolveRunnerExecWrapper, isBubblewrapWrapper, usernsRemediation } from "./runnerSandbox.js";
import {
  createSmithersRunRegistry,
  ENGINE_BEHAVIOR_ENV,
  isHubTerminalStatus,
  launchSmithers,
  resumeCheckpointMissingMessage,
  resumeCheckpointStatus,
  smithersCommand,
  smithersEventsArgs
} from "./runnerSmithersRuntime.js";
import {
  collectSmithersRunResult,
  smithersArtifactPayloads
} from "./runnerSmithersArtifacts.js";
import {
  createSmithersEventFollower,
  smithersFollowerArgs
} from "./runnerSmithersFollower.js";
import { smithersRunOutcome } from "./runnerSmithersOutcome.js";
import {
  createClaimAuthTracker,
  isAuthError
} from "./runnerClaimAuth.js";
import {
  activeRunnerLoad as computeActiveRunnerLoad,
  hasClaimCapacity as computeHasClaimCapacity,
  materializeAgentRuntimePack as writeAgentRuntimePack,
  materializeWorkflowBundle,
  preflightAssignment
} from "./runnerRuntime.js";
import { handleRunnerSpecialRun } from "./runnerSpecialRuns.js";
import { createRunnerCi, runnerCiConfigFromEnv } from "./runnerCi.js";
import { harnessSelectionRunEnv, resolveHarnessSelection } from "./runHarnessSelection.js";
import { loadRunnerConfigEnv } from "./runnerConfig.js";

const execFileAsync = promisify(execFile);
const runnerConfigEnv = loadRunnerConfigEnv();
const runnerBaseEnv = { ...process.env, ...runnerConfigEnv };

// Resolve once at startup: env override → pinned bun global install → PATH.
// Keeps the pinned smithers-orchestrator engine deterministic on dstack images.
const smithersBin = resolveSmithersBin();

const baseUrl = resolveHubUrl();
const token = resolveHubToken({ allowBootstrap: true });
const workspace = path.resolve(process.env.SMITHERS_WORKSPACE || process.cwd());
// Unopinionated launch-only execution seam: empty = run the engine directly on
// the host (default). RUNNER_SANDBOX=bubblewrap generates a bwrap sandbox argv;
// otherwise a literal RUNNER_EXEC_WRAPPER (docker/firejail/custom) is used
// verbatim. Only the workflow launch is wrapped — see resolveRunnerExecWrapper()
// and WRAPPED_SUBCOMMANDS. Needs `workspace`/`smithersBin`, hence resolved here.
const execWrapper = resolveRunnerExecWrapper({ workspace, smithersBin });

// Startup preflight: if the bubblewrap sandbox is selected, prove once that it
// can actually create a user namespace. A blocked userns (Ubuntu's restriction)
// would otherwise fail every launch cryptically; surface the fix up front. Runs
// the real wrapper against a no-op `/bin/sh -c :`; best-effort and non-fatal —
// launches already fail closed, so this is an early, actionable warning only.
if (isBubblewrapWrapper(execWrapper)) {
  try {
    execFileSync(execWrapper[0], [...execWrapper.slice(1), "/bin/sh", "-c", ":"], {
      timeout: 15_000,
      stdio: "ignore"
    });
  } catch {
    console.warn(`[sandbox] ${usernsRemediation()}`);
  }
}

// The engine version that will ACTUALLY execute runs. Since 0.27 the smithers
// binary delegates to the nearest project-local install walking up from cwd —
// a workspace `.smithers/node_modules` pack outranks the global binary — so
// this must be measured with cwd=workspace, exactly how every run is spawned.
// Drift against the pinned version is loud but non-fatal: an operator may be
// mid-upgrade, and the Hub-visible marker keeps the state honest.
function effectiveSmithersVersion() {
  try {
    return execFileSync(smithersBin, ["--version"], {
      cwd: workspace,
      timeout: 15_000,
      encoding: "utf8",
      env: { ...process.env, SMITHERS_NO_DAEMON: "1", SMITHERS_NO_UPDATE_CHECK: "1" }
    }).trim();
  } catch (error) {
    console.warn(`could not determine effective smithers version (${error.message}); launches may fail.`);
    return "";
  }
}
const engineVersion = effectiveSmithersVersion();
const engineDrift = Boolean(engineVersion && pinnedSmithersVersion && engineVersion !== pinnedSmithersVersion);
if (engineDrift) {
  console.warn(
    `[engine] VERSION DRIFT: effective smithers in ${workspace} is ${engineVersion}, but this runner expects ${pinnedSmithersVersion}. ` +
      `A workspace-local install (.smithers/node_modules) outranks the global binary — update the workspace pack ` +
      `(edit ${workspace}/.smithers/package.json to smithers-orchestrator ${pinnedSmithersVersion} and run 'bun install' there) or remove it.`
  );
} else if (engineVersion) {
  console.log(`[engine] effective smithers ${engineVersion} (pinned ${pinnedSmithersVersion || "unpinned"}) in ${workspace}`);
}

const location = process.env.SMITHERS_RUNNER_LOCATION || "vps"; // "vps" | "local"
const name = process.env.SMITHERS_RUNNER_NAME || `${os.hostname()} (${location})`;
// CI executor opt-in (specs/ci-platform.md): a CI-enabled runner advertises
// the `ci` tag the ci-job capability requires. Never advertised implicitly.
const runnerCiConfig = runnerCiConfigFromEnv(process.env);
const tags = normalizeRunnerTags(
  [
    ...(process.env.SMITHERS_RUNNER_TAGS || `smithers,${location}`)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    ...(runnerCiConfig.enabled ? ["ci"] : [])
  ],
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
let completedRuns = 0;
let intervalHandle = null;
const claimAuth = createClaimAuthTracker({ baseUrl });

function activeRunnerLoad() {
  return computeActiveRunnerLoad(activeRuns);
}

function hasClaimCapacity() {
  return computeHasClaimCapacity(activeRuns, concurrency);
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

// Report a recoverable interruption (credits/quota exhausted) as a pause
// instead of a failure. Best-effort by design: on any refusal (older Hub
// without the endpoint, a lost race with a terminal transition) the caller
// falls back to the plain fail path, so a run can never get stuck between
// the two reports.
async function pauseRunOnHub(runId, { reason = "", message = "", smithersRunId = "" } = {}) {
  try {
    await client.post(`/api/runs/${runId}/pause`, {
      ...(reason ? { reason } : {}),
      ...(message ? { message: String(message).slice(0, 2000) } : {}),
      pausedBy: "runner",
      resumable: true,
      ...(smithersRunId ? { resume: { smithersRunId, strategy: "smithers_resume" } } : {})
    });
    return true;
  } catch (error) {
    console.error(`pause report for ${runId} not accepted (falling back):`, error.message);
    return false;
  }
}

function materializeAgentRuntimePack(run, pack) {
  return writeAgentRuntimePack(run, pack, { workspace });
}

async function smithers(args, opts = {}) {
  // Prepend the deployer-configured exec wrapper for workflow-launch (`up`)
  // subcommands only; polling/control commands run the binary directly:
  //   launch + wrapper set -> `<wrapper[0]> <wrapper[1..]> <smithersBin> <args>`
  //   otherwise            -> `<smithersBin> <args>` (bare host)
  // See WRAPPED_SUBCOMMANDS in runnerSmithersRuntime.js.
  const command = smithersCommand({ smithersBin, execWrapper }, args);
  // Control-plane invocations (events/inspect/output/cancel/approve) inherit
  // the runner env plus the engine-behavior guards (no daemon autostart, no
  // update checks — see ENGINE_BEHAVIOR_ENV). Launches pass their own fully
  // assembled child env, which already includes the guards.
  const env = opts.env || { ...process.env, ...ENGINE_BEHAVIOR_ENV };
  if (!opts.stdin) {
    return execFileAsync(command.cmd, command.args, {
      cwd: workspace,
      timeout: opts.timeout || 60_000,
      maxBuffer: 1024 * 1024 * 32,
      env
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, command.args, {
      cwd: workspace,
      env,
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

const runnerCi = createRunnerCi({
  workspace,
  runnerName: name,
  runnerId: () => runnerId,
  client,
  event,
  failRun,
  config: runnerCiConfig,
  baseEnv: runnerBaseEnv
});

async function observedHubRun(runId) {
  try {
    const detail = await client.get(`/api/runs/${runId}`);
    return {
      status: detail?.run?.status || "",
      // Hub-computed: a human decision is pending on this run. While true, the
      // runner defers its execution deadline instead of timing the run out.
      approvalHold: Boolean(detail?.approvalHold)
    };
  } catch {
    return { status: "", approvalHold: false };
  }
}

// Event posts are the run's mirrored history on the Hub — and now feed live
// `--follow` streams — so a transient Hub blip gets a couple of bounded
// retries before the event is dropped (the follower's seq dedupe means a
// dropped post can never be replayed later). Still best-effort by design:
// event delivery must never fail the run itself.
const EVENT_POST_RETRY_DELAYS_MS = [500, 1500];
async function event(runId, type, message, data = {}) {
  const body = { type, message: String(message).slice(0, 4000), data };
  for (let attempt = 0; ; attempt++) {
    try {
      await client.post(`/api/runs/${runId}/events`, body);
      return;
    } catch (error) {
      if (attempt >= EVENT_POST_RETRY_DELAYS_MS.length) {
        console.error("event post failed:", error.message);
        return;
      }
      await sleep(EVENT_POST_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Report one observed model call to the Hub's usage ledger. Best-effort: a
// failed post never disturbs the run; the requestId keeps replays idempotent.
async function postRunUsage(runId, usage) {
  try {
    await client.post(`/api/runs/${runId}/usage`, usage);
  } catch (error) {
    console.error("usage post failed:", error.message);
  }
}

async function register() {
  // The effective engine version rides in the platform string so it is
  // visible on every existing runner surface (API, MCP, web runners table)
  // without a schema change; drift shows up as an explicit marker.
  const enginePlatformSuffix = engineVersion
    ? ` · smithers ${engineVersion}${engineDrift ? ` (DRIFT: expected ${pinnedSmithersVersion})` : ""}`
    : "";
  const res = await client.post("/api/runners/register", {
    id: runnerId || undefined,
    name,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}${enginePlatformSuffix}`,
    version: packageVersion,
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
// them, and never written to disk/inputs/logs. `harnessEnv` is the run's
// harness/endpoint selection (RUNYARD_RUN_* names and labels only, no
// credentials) resolved from run input / capability workflow config.
async function launch(entry, input, secretEnv = {}, resume = null, hubRunId = "", harnessEnv = {}) {
  const claudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || readClaudeOauthToken();
  const runEnv = {
    RUNYARD_RUN_ID: String(hubRunId || ""),
    SMITHERS_HUB_RUN_ID: String(hubRunId || ""),
    ...harnessEnv
  };
  return launchSmithers({
    runSmithers: smithers,
    entry,
    input,
    baseEnv: runnerBaseEnv,
    secretEnv,
    resume,
    workspace,
    token,
    baseUrl,
    maxInlineInputBytes: MAX_INLINE_INPUT_BYTES,
    claudeOauthToken,
    runEnv,
    hubRunId
  });
}

// Full-history fetch — terminal artifact collection ONLY, called exactly once
// per run after the engine is terminal. The streaming path is one incremental
// `events --json --watch` follower per run (src/runnerSmithersFollower.js);
// nothing re-reads the whole history while the run executes.
async function fetchEvents(sid) {
  try {
    const { stdout } = await smithers(smithersEventsArgs(sid));
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Live followers by hub run id, so shutdown can kill every follower child
// before exiting (executeAssignment's finally never runs past process.exit).
const activeFollowers = new Set();

function spawnSmithersFollower(sid) {
  // Control-plane read (local .smithers state, no untrusted code): runs the
  // smithers binary directly, never through the exec wrapper, and inherits
  // the runner env untouched — no run secrets enter the child or its argv.
  const command = smithersCommand({ smithersBin, execWrapper }, smithersFollowerArgs(sid));
  return spawn(command.cmd, command.args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
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
  let entry = capability.workflow?.entry || capability.workflow?.file;
  activeRuns.add(run.id);
  let follower = null;
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

    // CI jobs execute through the deterministic CI executor (native commands
    // or a Dagger call against a SHA-pinned checkout) — never `smithers up`.
    const handledCiRun = await runnerCi.handleCiRun({ capability, run, secretEnv });
    if (handledCiRun) return;

    // DB-backed workflows: write the Hub-shipped, hash-verified
    // bundle to a per-run file and point THIS run's entry at it (the stored
    // capability is untouched). Any materialization gap is a preflight failure
    // — a configured bundle never falls back to a checked-in template.
    let workflowBundle = null;
    let bundleFailure = "";
    try {
      workflowBundle = materializeWorkflowBundle(run, capability, assignment.workflowBundle, { workspace });
    } catch (error) {
      bundleFailure = `workflow bundle materialization failed: ${error.message || error}`;
    }
    if (workflowBundle) entry = workflowBundle.entry;

    const preflightFailures = bundleFailure
      ? [bundleFailure]
      : preflightAssignment(run, capability, entry, {
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
    if (workflowBundle) {
      // Metadata only — bundle source code never enters the event stream.
      await event(
        run.id,
        "runner.workflow_bundle_materialized",
        `Materialized workflow bundle ${workflowBundle.bundleId} v${workflowBundle.version} for ${capability.slug}`,
        {
          bundleId: workflowBundle.bundleId,
          version: workflowBundle.version,
          sha256: workflowBundle.sha256,
          sizeBytes: workflowBundle.sizeBytes,
          path: workflowBundle.entry
        }
      );
    }
    await event(run.id, "runner.started", `Executing Smithers workflow ${entry} on ${name}`, { runnerId, entry, location });

    // A resume request carries the prior Smithers run id in __resume. Verify
    // the checkpoint actually exists in local .smithers state before launching:
    // a detached `smithers up --resume` reports RUN_NOT_FOUND only inside its
    // background child, so a missing checkpoint would otherwise hang the poll
    // loop until the deadline fails the run hours later with a bogus timeout.
    // Instead the run re-parks explicitly as a resume failure, checkpoint
    // dropped, so the operator's next resume honestly re-runs from scratch.
    const resume = run.input && typeof run.input === "object" ? run.input.__resume : null;
    if (resume?.smithersRunId) {
      const checkpoint = await resumeCheckpointStatus({ inspectRun: getState, smithersRunId: resume.smithersRunId });
      if (!checkpoint.ok) {
        const message = resumeCheckpointMissingMessage(resume.smithersRunId, checkpoint.error);
        await event(run.id, "runner.resume_checkpoint_missing", message, {
          smithersRunId: resume.smithersRunId,
          attempt: resume.attempt || null,
          reason: PAUSE_REASONS.RESUME_FAILED
        });
        if (await pauseRunOnHub(run.id, { reason: PAUSE_REASONS.RESUME_FAILED, message })) {
          console.log(`Run ${run.id} re-paused: resume checkpoint ${resume.smithersRunId} missing`);
        } else {
          await failRun(run.id, message, RUN_FAILURE_CLASSES.INFRA_UNAVAILABLE);
          console.log(`Run ${run.id} failed: resume checkpoint ${resume.smithersRunId} missing and pause was refused`);
        }
        return;
      }
    }
    const runtimeEnv = materializeAgentRuntimePack(run, assignment.agentRuntimePack);
    // Per-run harness/endpoint selection (validated by preflight above) rides
    // the runEnv channel so it outranks the runner's ambient RUNYARD_* env.
    const harnessEnv = harnessSelectionRunEnv(resolveHarnessSelection({ capability, input: run.input || {} }).selection);

    // Gateway-metered run: pin the child agent to the Hub's metering gateway
    // (per-run pi config dir + run-scoped token) and make sure the withheld
    // provider key can't reach the child even if a stale Hub sent it.
    const gateway = assignment.gateway && typeof assignment.gateway === "object" ? assignment.gateway : null;
    const effectiveSecretEnv = { ...runtimeEnv, ...secretEnv };
    let gatewayEnv = {};
    if (gateway) {
      try {
        gatewayEnv = materializeGatewayPin({ workspace, runId: run.id, gateway, hubUrl: baseUrl });
      } catch (error) {
        const message = `metering gateway pin failed: ${error.message || error}`;
        await event(run.id, "runner.preflight_failed", message, { runnerId, failureClass: RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT });
        await failRun(run.id, message, RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT);
        return;
      }
      for (const name of gateway.excludeSecretNames || []) delete effectiveSecretEnv[name];
      await event(
        run.id,
        "runner.metering_gateway",
        `Child agent pinned to metering gateway at ${gatewayEnv.RUNYARD_RUN_PI_BASE_URL} (model ${gateway.model}); provider key withheld from child env`,
        { model: gateway.model, provider: gateway.provider }
      );
    }
    const sid = await launch(entry, run.input, effectiveSecretEnv, resume, run.id, { ...harnessEnv, ...gatewayEnv });
    smithersRegistry.register(run.id, sid);
    if (resume?.smithersRunId) {
      await event(run.id, "runner.resumed", `Resuming Smithers run ${sid} from checkpoint (attempt ${resume.attempt || "?"})`, {
        smithersRunId: sid,
        resumedFrom: resume.smithersRunId,
        attempt: resume.attempt || null
      });
    }
    await event(run.id, "smithers.dispatched", `Smithers run ${sid} started`, { smithersRunId: sid });

    // Bridge engine-level <Approval> pauses to the Hub: without it those waits
    // emit no run events and create no approval card, so the stall reaper would
    // fail a run that is deliberately parked on a human decision.
    const engineApprovals = createEngineApprovalBridge({
      hubRunId: run.id,
      smithersRunId: sid,
      capabilitySlug: capability.slug,
      runnerName: name,
      // Seed-registered asks for the workflow's <Approval> gates, so the Hub
      // card carries the author's question even on engines whose inspect
      // doesn't expose the request (0.22).
      gateAsks: capability.approvalPolicy?.gates || {},
      postEvent: (type, message, data) => event(run.id, type, message, data),
      hubGet: (pathname) => client.get(pathname),
      hubPost: (pathname, body) => client.post(pathname, body),
      runSmithers: smithers,
      // Smithers ≥0.24 detached owners exit at an approval gate; once the
      // decision is applied the bridge relaunches the run from its checkpoint
      // with the exact same env/entry the original launch used.
      resumeEngineRun: () =>
        launch(entry, run.input, effectiveSecretEnv, { smithersRunId: sid }, run.id, { ...harnessEnv, ...gatewayEnv }),
      logError: console.error
    });

    // Stream Smithers events to the Hub as they happen: ONE incremental
    // `events --json --watch` follower per run (initial backlog, then pages,
    // then a terminal drain — see runnerSmithersFollower.js) instead of
    // re-reading the whole history every poll. Delivery is serialized, so
    // approvals/usage/event posts keep their engine order; a follower restart
    // replays the backlog but the per-run seq dedupe drops what was already
    // posted.
    follower = createSmithersEventFollower({
      spawnFollower: () => spawnSmithersFollower(sid),
      // Approval observation + event post + runner-observed usage (the
      // gateway-metered model is excluded so nothing double-counts).
      onLine: createFollowerLineHandler({
        observeEventLine: (line) => engineApprovals.observeEventLine(line),
        postEvent: (message) => event(run.id, "smithers.event", message),
        postUsage: (usage) => postRunUsage(run.id, usage),
        gatewayModel: gateway?.model || ""
      }),
      logError: (message) => console.error(`[follower ${run.id}] ${message}`),
      // A zero exit is only trusted as "terminal drain complete" when the
      // engine run really is terminal; an externally signalled watch child
      // restarts instead of silently truncating the stream.
      isEngineTerminal: async () => {
        const st = await getState(sid);
        return TERMINAL.has(st.runState?.state || st.run?.status || "running");
      }
    });
    activeFollowers.add(follower);
    follower.start();

    // Poll loop is control-plane only now: engine state, hub status
    // (pause/cancel/terminal), approval holds, and the execution deadline.
    let state = "running";
    let deadline = Date.now() + maxRunMs;
    let deadlineExceeded = false;
    let hubTerminalStatus = "";
    while (Date.now() < deadline) {
      try {
        const st = await getState(sid);
        state = st.runState?.state || st.run?.status || "running";
        await engineApprovals.tick(st);
      } catch {
        /* keep polling */
      }
      const hubRun = await observedHubRun(run.id);
      hubTerminalStatus = hubRun.status;
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
      // Hub/gateway/operator paused the run: halt the detached engine run
      // (smithers cancel stops the agents; the checkpoint in local .smithers
      // state persists), attach that checkpoint to the pause record so resume
      // can continue from it, and release this slot WITHOUT reporting
      // complete/fail — paused is the run's durable state now.
      if (hubRun.status === "paused") {
        await event(
          run.id,
          "runner.hub_pause_observed",
          `Hub paused run; halting Smithers run ${sid} and preserving its checkpoint for resume.`,
          { smithersRunId: sid }
        );
        await cancelSmithersRun(sid, "hub paused run");
        await pauseRunOnHub(run.id, { smithersRunId: sid });
        console.log(`Run ${run.id} paused by hub; detached from smithers ${sid}`);
        return;
      }
      // The engine parked the run on a provider quota window (`waiting-quota`,
      // structured since 0.27). Without a gateway daemon nothing auto-wakes
      // it, so mirror it as a structured Hub pause carrying the checkpoint —
      // the same recoverable-interruption contract the text classifier
      // provides for credit errors, but from a real engine state instead of
      // error-text scraping. On any pause refusal keep polling; the run can
      // still settle terminally or time out under the normal rules.
      if (state === "waiting-quota") {
        await event(
          run.id,
          "runner.pause_detected",
          `Engine parked the run as waiting-quota; reporting a structured pause with checkpoint ${sid}.`,
          { smithersRunId: sid, reason: PAUSE_REASONS.QUOTA_EXHAUSTED, engineState: state }
        );
        await cancelSmithersRun(sid, "engine waiting-quota; parking as Hub pause");
        if (await pauseRunOnHub(run.id, { reason: PAUSE_REASONS.QUOTA_EXHAUSTED, message: `Smithers parked run ${sid} as waiting-quota.`, smithersRunId: sid })) {
          console.log(`Run ${run.id} paused (quota) with checkpoint smithers ${sid}`);
          return;
        }
      }
      if (TERMINAL.has(state)) break;
      // An approval-held run is blocked on a pending human decision. Approvals
      // are blocking by contract: a late human must never turn into a timed_out
      // failure, so the deadline is pushed out instead of expiring under them.
      // The margin is several polls wide so a slow iteration near the boundary
      // cannot slip past the hold check, and the deferral event doubles as
      // liveness so the Hub's stall reaper sees the run is deliberately parked.
      if (hubRun.approvalHold && Date.now() + 10 * pollMs >= deadline) {
        deadline = Date.now() + maxRunMs;
        await event(
          run.id,
          "runner.deadline_deferred",
          `Run is blocked on a pending human approval; deferring the runner deadline by ${maxRunMs}ms instead of timing out.`,
          { smithersRunId: sid, maxRunMs }
        );
      }
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

    // Let the follower finish its own terminal drain (the watch loop exits 0
    // once the engine run is terminal and remaining pages are flushed), then
    // stop it — stop() also waits for in-flight Hub posts, so every streamed
    // event lands before the terminal artifacts/completion report.
    await follower.waitForExit(15_000);
    await follower.stop();

    const {
      inspect: st,
      outputs,
      eventLines
    } = await collectSmithersRunResult(sid, {
      getState,
      nodeOutput,
      // Terminal artifact collection does exactly ONE bounded full fetch (the
      // pre-follower behavior): the smithers-events.ndjson artifact is the
      // durable record, and a freak follower truncation (externally signalled
      // watch child racing the terminal transition) must not corrupt it. The
      // follower's accumulated lines are the fallback if that fetch fails.
      fetchEvents: async () => {
        const lines = await fetchEvents(sid);
        return lines.length ? lines : follower.lines;
      }
    });
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
      // A failure whose error text clearly means exhausted credits/quota is a
      // recoverable interruption: report a pause carrying the Smithers
      // checkpoint instead of a terminal failure. Today this classifies the
      // engine's error text (Smithers 0.22 exposes no structured pause/credit
      // event); the Hub-side gateway sees the raw provider 402 for
      // gateway-metered runs. Any refusal falls through to the normal fail.
      const pauseReason = deadlineExceeded ? null : classifyPauseReason(outcome.error);
      if (pauseReason && sid) {
        await event(run.id, "runner.pause_detected", `Recoverable provider interruption (${pauseReason}); reporting pause instead of failure.`, {
          smithersRunId: sid,
          reason: pauseReason
        });
        if (await pauseRunOnHub(run.id, { reason: pauseReason, message: outcome.error, smithersRunId: sid })) {
          console.log(`Run ${run.id} paused (${pauseReason}) with checkpoint smithers ${sid}`);
          return;
        }
      }
      await failRun(run.id, outcome.error, outcome.status);
      console.log(`Run ${run.id} ended '${state}' (smithers ${sid})`);
    }
  } catch (error) {
    // ≥0.30 validates detached launches before spawning: a broken workflow
    // exits with a structured envelope and no run id. Surface the engine's own
    // file:line:col diagnostic and class it as a preflight block so operators
    // see WHY the launch died, not just that no run id appeared.
    const launchFailure = error?.smithersLaunchFailure;
    if (launchFailure) {
      await event(run.id, "runner.launch_failed", error.message, {
        runnerId,
        code: launchFailure.code,
        ...(launchFailure.preflight ? { failureClass: RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT } : {})
      }).catch(() => {});
      await failRun(run.id, error.message, launchFailure.preflight ? RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT : "").catch(() => {});
    } else {
      await failRun(run.id, error.stack || error.message).catch(() => {});
    }
    console.error(`Run ${run.id} failed:`, error.message);
  } finally {
    if (follower) {
      await follower.stop().catch(() => {});
      activeFollowers.delete(follower);
    }
    smithersRegistry.unregister(run.id);
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
        activeRuns: load.work,
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
    // Kill every live event follower FIRST — executeAssignment's finally
    // never runs past process.exit, and even if cancelAll throws below, a
    // leaked watch child would otherwise poll its engine run forever.
    await Promise.all([...activeFollowers].map((f) => f.stop().catch(() => {})));
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
