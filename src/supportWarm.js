// Warm support-agent path.
//
// The in-app assistant used to run a full `smithers up` per chat message: spawn
// Smithers, compile the workflow, cold-start a CLI agent, poll for output. That
// is ~15s and (under load) reap-prone. This module answers the same
// `runyard-support-agent` capability by calling the local `claude` CLI directly
// in headless print mode (~3s), using the host's Claude subscription — no API
// key, no Smithers wrapper, no queue.
//
// Memory is not session state here: the Hub passes the full `messages`
// transcript in every run input, so we feed the whole conversation each turn and
// the agent never "forgets". This path is gated by SUPPORT_WARM=1 and only set
// on the dedicated support-runner, so the general runner pool is untouched.

import { execFile } from "node:child_process";
import { allowlistedBaseEnv } from "./childEnv.js";
import { readClaudeOauthToken } from "./claudeOauthToken.js";
import { parseBool } from "./configParsing.js";
import { resolveHubUrl } from "./hubConnection.js";

const CLAUDE_BIN = process.env.SUPPORT_WARM_CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.SUPPORT_WARM_MODEL || "claude-sonnet-4-6";
const TIMEOUT_MS = Number(process.env.SUPPORT_WARM_TIMEOUT_MS || 90_000);
const MAX_BUFFER = 8 * 1024 * 1024;

// Read access via server-side pre-fetch (gated by SUPPORT_WARM_TOOLS=1). Rather
// than give the headless agent an agentic tool loop (slow + permission-prone),
// we detect which capability/run the question is about and inject that live
// data into the prompt, so the agent answers in a single fast turn instead of
// deflecting with "I can't fetch that". Uses a scope:["read"] token; the server
// rejects any mutation, so this is read-only by construction.
const READ_ENABLED = parseBool(process.env.SUPPORT_WARM_TOOLS, false);
const READ_TOKEN = process.env.RUNYARD_READ_TOKEN || "";
const READ_HUB_URL = resolveHubUrl();

async function hubGet(apiPath) {
  if (!READ_TOKEN) return null;
  try {
    const res = await fetch(`${READ_HUB_URL}/api/${apiPath}`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Pull the live Hub data relevant to this turn: the workflow catalog (always —
// small + high value), the full definition of any workflow the operator named,
// and any run id they referenced. Returned as a text block appended to the
// prompt so the model has real data to answer from.
async function gatherRelevantHubData(input) {
  if (!READ_ENABLED) return "";
  // Match against what the operator actually asked (their last message) plus a
  // few focused context fields — NOT the whole context blob, which mentions many
  // workflows from recent runs and would pull in the wrong/too-many defs and
  // bloat the prompt (slowing the model badly).
  const lastUser = [...(input.messages || [])].reverse().find((m) => m?.role === "user");
  const ctx = input.context || {};
  const focus = [ctx.view, ctx.route, ctx.hash, ctx.runId, ctx.capabilitySlug, ctx.slug].filter(Boolean).join(" ");
  const haystack = `${typeof lastUser?.content === "string" ? lastUser.content : ""} ${focus}`;
  const blocks = [];

  const capsRaw = await hubGet("workflows");
  let caps = [];
  if (capsRaw) {
    try {
      caps = (JSON.parse(capsRaw).workflows || []).filter((c) => c?.slug);
    } catch {
      /* ignore */
    }
  }

  const matched = caps.filter((c) => new RegExp(`\\b${c.slug.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(haystack));
  const runIds = [...new Set(haystack.match(/run_[0-9a-f]{6,}/g) || [])].slice(0, 2);

  // Inject the FULL definition of any workflow the operator named.
  for (const c of matched.slice(0, 2)) {
    const def = await hubGet(`workflows/${encodeURIComponent(c.slug)}`);
    if (def) blocks.push(`Full definition of workflow "${c.slug}":\n${def.slice(0, 4500)}`);
  }
  for (const rid of runIds) {
    const run = await hubGet(`runs/${rid}`);
    if (run) blocks.push(`Run ${rid} detail:\n${run.slice(0, 3500)}`);
  }

  // Only fall back to the compact catalog when nothing specific matched — keeps
  // the prompt (and so the model latency) small for targeted questions.
  if (!blocks.length && caps.length) {
    const list = caps
      .map((c) => `- ${c.slug}: ${(c.name || "").trim()}${c.description ? ` — ${String(c.description).slice(0, 80)}` : ""}`)
      .join("\n");
    blocks.push(`Workflow catalog (${caps.length} workflows):\n${list.slice(0, 2500)}`);
  }

  return blocks.length ? `\n\nLive Hub data fetched for this question:\n${blocks.join("\n\n")}` : "";
}

export function supportWarmEnabled() {
  return parseBool(process.env.SUPPORT_WARM, false);
}

function renderTranscript(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .map((m) => {
      const role = m?.role === "assistant" ? "Assistant" : m?.role === "system" ? "System" : "Operator";
      const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      return `${role}: ${content}`;
    })
    .join("\n\n");
}

// Build the single prompt we hand to `claude -p`. The persona/system lives in
// --append-system-prompt; here we give the live Hub context plus the full
// transcript, then ask for the next assistant reply.
function buildPrompt({ messages, context }) {
  const parts = [];
  if (context && Object.keys(context).length) {
    parts.push(`Live Hub context (what the operator is currently looking at):\n${JSON.stringify(context, null, 2)}`);
  }
  parts.push(`Conversation so far:\n${renderTranscript(messages) || "(no prior messages)"}`);
  parts.push(
    "Write the assistant's next reply. Be concise and directly useful. " +
      "If a follow-up action would help, you may end with the single fenced JSON button block described in your instructions."
  );
  return parts.join("\n\n");
}

// Env for the headless `claude` child — same allowlist discipline as the
// Smithers launch path (childEnv.js). The support runner carries hub tokens
// (RUNYARD_READ_TOKEN) and other secrets a spawned CLI has no business
// inheriting; the child gets the OS/toolchain baseline plus exactly one
// credential: the Claude OAuth token (ambient env first, runner-local token
// file as fallback — same precedence the full-env spread had).
export function supportWarmChildEnv({ baseEnv = process.env, readToken = readClaudeOauthToken } = {}) {
  const env = allowlistedBaseEnv(baseEnv);
  const token = baseEnv.CLAUDE_CODE_OAUTH_TOKEN || readToken();
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

function runClaude(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const env = supportWarmChildEnv();
    execFile(
      CLAUDE_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, cwd: process.env.HOME || "/home/xiko", env },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = String(stderr || "");
          return reject(error);
        }
        resolve(String(stdout || ""));
      }
    );
  });
}

// Answer one support-chat turn. Returns the reply string. Throws on failure so
// the runner marks the run failed and the Hub surfaces a real error rather than
// a silent empty reply.
export async function warmSupportReply(input = {}) {
  const system = typeof input.system === "string" ? input.system : "";
  const hubData = await gatherRelevantHubData(input);
  const prompt = buildPrompt({ messages: input.messages, context: input.context }) + hubData;

  // Force a single-turn text answer from the injected context. Two guards:
  //  --strict-mcp-config ignores the host's ambient MCP servers (gdrive, gmail,
  //    a runyard MCP, ...) so the agent doesn't try to call them.
  //  --disallowedTools turns off every built-in tool, so it can't burn turns (or
  //    stall on headless permission prompts) trying to "fetch" — it just answers
  //    from the live Hub data we already pre-fetched. Cuts latency ~25s -> ~3s.
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--model", CLAUDE_MODEL,
    "--strict-mcp-config",
    "--disallowedTools", "Bash,Read,Edit,Write,WebFetch,WebSearch,Glob,Grep,Task,TodoWrite,NotebookEdit,BashOutput,KillShell"
  ];
  if (system) args.push("--append-system-prompt", system);

  const stdout = await runClaude(args, { timeoutMs: TIMEOUT_MS });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Some CLI versions stream non-JSON preamble; fall back to the last JSON line.
    const line = stdout.split(/\r?\n/).filter(Boolean).reverse().find((l) => l.trim().startsWith("{"));
    parsed = line ? JSON.parse(line) : null;
  }
  if (!parsed) throw new Error(`warm support: could not parse claude output: ${stdout.slice(0, 200)}`);
  if (parsed.is_error) throw new Error(`warm support: claude reported error: ${String(parsed.result || "").slice(0, 300)}`);

  const reply = typeof parsed.result === "string" ? parsed.result : "";
  if (!reply.trim()) throw new Error("warm support: claude returned an empty reply");
  return reply.trim();
}
