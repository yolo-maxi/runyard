import path from "node:path";
import { largeInputPayload } from "./runnerPolicy.js";
import { allowlistedBaseEnv } from "./childEnv.js";

export const HUB_TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "blocked_by_gate",
  "blocked_by_preflight",
  "provider_limited",
  "timed_out",
  "invalid_output",
  "infra_unavailable",
  "needs_human",
  "budget_exceeded",
  "cancelled"
]);

// Smithers subcommands that spawn the workflow/agent child — i.e. run untrusted
// build code — and therefore go through the deployer's exec wrapper (sandbox,
// container, job launcher). Everything else the runner invokes is control-plane:
// polling (events/inspect/output) and cancellation (cancel). Those run the
// smithers binary directly against local `.smithers/` state, execute no
// untrusted code, and MUST stay unwrapped. Keep this set tight: only launch
// verbs belong here.
export const WRAPPED_SUBCOMMANDS = new Set(["up"]);

export function smithersCommand({ smithersBin, execWrapper = [] } = {}, args = []) {
  const wrap = execWrapper.length > 0 && WRAPPED_SUBCOMMANDS.has(args[0]);
  const cmd = wrap ? execWrapper[0] : smithersBin;
  const fullArgs = wrap ? [...execWrapper.slice(1), smithersBin, ...args] : args;
  return { cmd, args: fullArgs };
}

// Engine-behavior guards for every smithers invocation the runner makes.
// Smithers ≥0.27 may autostart a per-workspace gateway daemon from CLI
// commands and nudges about updates; ≥0.27 also auto-launches a post-failure
// "autopsy" workflow by default. A RunYard runner must never sprout
// unmanaged daemons, background update checks, or engine-initiated runs —
// the Hub is the only lifecycle authority — so these are pinned off for the
// launch child and for control-plane calls alike. Explicit secretEnv/runEnv
// values still win (they merge later).
export const ENGINE_BEHAVIOR_ENV = Object.freeze({
  SMITHERS_NO_DAEMON: "1",
  SMITHERS_NO_UPDATE_CHECK: "1",
  SMITHERS_POST_FAILURE: "0"
});

export function runyardChildEnv({ baseEnv = process.env, token = "", baseUrl = "", secretEnv = {}, claudeOauthToken = "", runEnv = {} } = {}) {
  const hubEnv = {};
  if (token) hubEnv.RUNYARD_HUB_TOKEN = token;
  if (baseUrl) hubEnv.RUNYARD_HUB_URL = baseUrl;
  if (claudeOauthToken && !secretEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    hubEnv.CLAUDE_CODE_OAUTH_TOKEN = claudeOauthToken;
  }
  // Only the OS/toolchain baseline from baseEnv reaches the child; the runner's
  // own secrets stay behind. Everything the workflow needs comes through the
  // explicit hub / secretEnv / runEnv channels below (highest precedence).
  return { ...allowlistedBaseEnv(baseEnv), ...ENGINE_BEHAVIOR_ENV, ...hubEnv, ...secretEnv, ...runEnv };
}

// Harness name stamped into the engine's persisted launch attribution
// (smithers ≥0.30 `--started-by-*`). Without it the engine guesses from the
// runner's ambient environment and records the wrong harness.
export const ENGINE_LAUNCH_HARNESS = "runyard-runner";

export function smithersLaunchRequest({ entry, input, workspace, resume = null, maxInlineInputBytes, hubRunId = "" }) {
  const workflowPath = path.isAbsolute(entry) ? entry : path.join(workspace, entry);
  const cleanInput = { ...(input || {}) };
  delete cleanInput.__resume;
  const inputPayload = largeInputPayload(cleanInput, maxInlineInputBytes);
  const args = ["up", workflowPath];
  if (inputPayload.stdin) args.push("--input", "-");
  else args.push("--input", inputPayload.inline);
  args.push("-d", "--format", "json");
  // Belt to ENGINE_BEHAVIOR_ENV's braces: the launch verb itself declares that
  // RunYard owns failure handling (no engine-spawned autopsy runs).
  args.push("--no-post-failure");
  args.push("--started-by-harness", ENGINE_LAUNCH_HARNESS);
  if (hubRunId) args.push("--started-by-session", String(hubRunId));
  if (resume?.smithersRunId) {
    args.push("--resume", String(resume.smithersRunId), "--force");
  }
  return {
    args,
    stdin: inputPayload.stdin || "",
    workflowPath
  };
}

// A detached `smithers up --resume <sid>` only validates the checkpoint
// (RUN_NOT_FOUND) inside the spawned background child — the parent returns the
// run id immediately. Without a pre-check, a missing checkpoint would leave
// the runner polling a run that never exists until the execution deadline
// kills it hours later as a bogus timeout. So the runner verifies the
// checkpoint in local .smithers state BEFORE launching (inspect is a
// control-plane read; it executes no untrusted code) and reports an explicit
// resume failure instead.
export async function resumeCheckpointStatus({ inspectRun, smithersRunId }) {
  try {
    await inspectRun(smithersRunId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 500) };
  }
}

export function resumeCheckpointMissingMessage(smithersRunId, detail = "") {
  const suffix = detail ? ` (inspect said: ${String(detail).replace(/\s+/g, " ").trim().slice(0, 200)})` : "";
  return `Recorded engine checkpoint ${smithersRunId} was not found in this runner's local .smithers state${suffix}; it may have been cleaned or the workspace replaced. The run is re-paused with the stale checkpoint dropped — resume again to re-run from scratch, or cancel.`;
}

export function parseSmithersRunId(stdout = "") {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.runId) return parsed.runId;
  } catch {
    /* fall through to regex */
  }
  const match = String(stdout).match(/run-\d+/);
  if (match) return match[0];
  throw new Error(`could not determine smithers runId from: ${String(stdout).slice(0, 200)}`);
}

// Smithers ≥0.30 validates a workflow BEFORE spawning the detached child: a
// bad file exits non-zero with a JSON envelope {code, message} (message
// carries file:line:col) and no run is created. Surface that as a structured
// launch failure so the Hub records why the launch died instead of a generic
// "could not determine smithers runId".
export function smithersLaunchFailure(error) {
  for (const channel of [error?.stdout, error?.stderr, error?.message]) {
    const text = String(channel || "").trim();
    if (!text) continue;
    const jsonStart = text.indexOf("{");
    if (jsonStart === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      if (parsed && typeof parsed === "object" && parsed.code && parsed.message) {
        return {
          code: String(parsed.code),
          message: String(parsed.message).slice(0, 2000),
          preflight: String(parsed.code) === "DETACHED_PREFLIGHT_FAILED"
        };
      }
    } catch {
      /* not an envelope; try the next channel */
    }
  }
  return null;
}

// Poll argv for the engine event stream. `--raw` is load-bearing on ≥0.28:
// the default `events` view filters to lifecycle types and silently drops
// TokenUsageReported (usage metering), agent/tool history, and scorer events.
// 0.22 had no filter, so --raw is exact parity with what the runner has
// always consumed.
export function smithersEventsArgs(smithersRunId) {
  return ["events", String(smithersRunId), "--json", "--raw", "--limit", "100000"];
}

export function isHubTerminalStatus(status) {
  return HUB_TERMINAL_STATUSES.has(String(status || ""));
}

export function createSmithersRunRegistry({ cancelSmithersRun, event, logError = console.error } = {}) {
  const active = new Map();

  function register(runId, smithersRunId) {
    if (!runId || !smithersRunId) return;
    active.set(String(runId), String(smithersRunId));
  }

  function unregister(runId) {
    if (!runId) return;
    active.delete(String(runId));
  }

  async function cancelRun(runId, reason = "") {
    const smithersRunId = active.get(String(runId));
    if (!smithersRunId) return false;
    if (event) {
      await event(String(runId), "runner.cancel_smithers", reason || `Cancelling Smithers run ${smithersRunId}`, {
        smithersRunId,
        reason
      });
    }
    try {
      return await cancelSmithersRun(smithersRunId, reason);
    } catch (error) {
      logError(`failed to cancel Smithers run ${smithersRunId}:`, error.message);
      return false;
    }
  }

  async function cancelAll(reason = "") {
    const entries = [...active.entries()];
    await Promise.all(entries.map(([runId]) => cancelRun(runId, reason)));
    return entries.length;
  }

  return {
    active,
    cancelAll,
    cancelRun,
    register,
    unregister
  };
}

export async function launchSmithers({
  runSmithers,
  entry,
  input,
  baseEnv = process.env,
  secretEnv = {},
  resume = null,
  workspace,
  token,
  baseUrl,
  maxInlineInputBytes,
  claudeOauthToken = "",
  runEnv = {},
  hubRunId = ""
}) {
  const request = smithersLaunchRequest({ entry, input, workspace, resume, maxInlineInputBytes, hubRunId });
  let stdout;
  try {
    ({ stdout } = await runSmithers(request.args, {
      env: runyardChildEnv({ baseEnv, token, baseUrl, secretEnv, claudeOauthToken, runEnv }),
      ...(request.stdin ? { stdin: request.stdin } : {})
    }));
  } catch (error) {
    // ≥0.30 fail-fast: no run exists yet, so report the engine's own
    // diagnostic (file:line:col for a broken workflow) instead of a bare
    // non-zero exit.
    const failure = smithersLaunchFailure(error);
    if (failure) {
      const launchError = new Error(`smithers launch failed before a run id existed (${failure.code}): ${failure.message}`);
      launchError.smithersLaunchFailure = failure;
      throw launchError;
    }
    throw error;
  }
  return parseSmithersRunId(stdout);
}
