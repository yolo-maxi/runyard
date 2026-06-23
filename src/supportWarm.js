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

const CLAUDE_BIN = process.env.SUPPORT_WARM_CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.SUPPORT_WARM_MODEL || "claude-sonnet-4-6";
const TIMEOUT_MS = Number(process.env.SUPPORT_WARM_TIMEOUT_MS || 90_000);
const MAX_BUFFER = 8 * 1024 * 1024;

export function supportWarmEnabled() {
  return process.env.SUPPORT_WARM === "1" || process.env.SUPPORT_WARM === "true";
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

function runClaude(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, cwd: process.env.HOME || "/home/xiko", env: process.env },
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
  const prompt = buildPrompt({ messages: input.messages, context: input.context });

  const args = ["-p", prompt, "--output-format", "json", "--model", CLAUDE_MODEL];
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
