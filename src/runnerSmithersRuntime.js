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
  return { ...allowlistedBaseEnv(baseEnv), ...hubEnv, ...secretEnv, ...runEnv };
}

export function smithersLaunchRequest({ entry, input, workspace, resume = null, maxInlineInputBytes }) {
  const workflowPath = path.isAbsolute(entry) ? entry : path.join(workspace, entry);
  const cleanInput = { ...(input || {}) };
  delete cleanInput.__resume;
  const inputPayload = largeInputPayload(cleanInput, maxInlineInputBytes);
  const args = ["up", workflowPath];
  if (inputPayload.stdin) args.push("--input", "-");
  else args.push("--input", inputPayload.inline);
  args.push("-d", "--format", "json");
  if (resume?.smithersRunId) {
    args.push("--resume", String(resume.smithersRunId), "--force");
  }
  return {
    args,
    stdin: inputPayload.stdin || "",
    workflowPath
  };
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
  runEnv = {}
}) {
  const request = smithersLaunchRequest({ entry, input, workspace, resume, maxInlineInputBytes });
  const { stdout } = await runSmithers(request.args, {
    env: runyardChildEnv({ baseEnv, token, baseUrl, secretEnv, claudeOauthToken, runEnv }),
    ...(request.stdin ? { stdin: request.stdin } : {})
  });
  return parseSmithersRunId(stdout);
}
