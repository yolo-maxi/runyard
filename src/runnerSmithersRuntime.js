import path from "node:path";
import { largeInputPayload } from "./runnerPolicy.js";

export function smithersCommand({ smithersBin, execWrapper = [] } = {}, args = []) {
  const cmd = execWrapper.length ? execWrapper[0] : smithersBin;
  const fullArgs = execWrapper.length ? [...execWrapper.slice(1), smithersBin, ...args] : args;
  return { cmd, args: fullArgs };
}

export function supervisorChildEnv({ baseEnv = process.env, token = "", baseUrl = "", secretEnv = {}, claudeOauthToken = "" } = {}) {
  const supervisorEnv = {};
  if (token) supervisorEnv.RUN_SMITHERS_HUB_TOKEN = token;
  if (baseUrl) supervisorEnv.RUN_SMITHERS_HUB_URL = baseUrl;
  if (claudeOauthToken && !secretEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    supervisorEnv.CLAUDE_CODE_OAUTH_TOKEN = claudeOauthToken;
  }
  return { ...baseEnv, ...supervisorEnv, ...secretEnv };
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

export async function launchSmithers({
  runSmithers,
  entry,
  input,
  secretEnv = {},
  resume = null,
  workspace,
  token,
  baseUrl,
  maxInlineInputBytes,
  claudeOauthToken = ""
}) {
  const request = smithersLaunchRequest({ entry, input, workspace, resume, maxInlineInputBytes });
  const { stdout } = await runSmithers(request.args, {
    env: supervisorChildEnv({ token, baseUrl, secretEnv, claudeOauthToken }),
    ...(request.stdin ? { stdin: request.stdin } : {})
  });
  return parseSmithersRunId(stdout);
}
