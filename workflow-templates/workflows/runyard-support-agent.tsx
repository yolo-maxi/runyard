// smithers-source: authored
// smithers-display-name: Runyard Support Agent
// smithers-description: Internal in-app support chat answered by a subscribed on-runner CLI agent.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, CodexAgent, ClaudeCodeAgent, PiAgent } from "smithers-orchestrator";
import { z } from "zod/v4";
import { withAgentFallback } from "./agent-fallback.js";
import { createPiAgentFromEnv, resolveAgentCli } from "./pi-harness.js";

const inputSchema = z.object({
  system: z.string().default(""),
  messages: z.array(z.looseObject({
    role: z.string().default("user"),
    content: z.string().default("")
  })).default([]),
  context: z.looseObject({}).default({})
});

const supportOutput = z.looseObject({
  reply: z.string().default("")
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  support: supportOutput
});

const provider = resolveAgentCli(process.env, { workflow: "SUPPORT", fallback: "claude" });

const codex = new CodexAgent({
  model: process.env.RUNYARD_SUPPORT_CODEX_MODEL || (provider === "codex" ? process.env.RUNYARD_SUPPORT_AGENT_MODEL : "") || "gpt-5.3-codex",
  sandbox: "read-only",
  timeoutMs: 2 * 60 * 1000,
  systemPrompt:
    "You are answering inside Runyard's floating support chat. Return only JSON with a string field named reply. " +
    "Keep the reply concise and preserve any valid trailing buttons JSON block requested by the system prompt."
});

const claude = new ClaudeCodeAgent({
  model: process.env.RUNYARD_SUPPORT_CLAUDE_MODEL || (provider === "claude" ? process.env.RUNYARD_SUPPORT_AGENT_MODEL : "") || "claude-sonnet-4-6",
  allowedTools: [],
  timeoutMs: 2 * 60 * 1000,
  systemPrompt:
    "You are answering inside Runyard's floating support chat. Return only JSON with a string field named reply. " +
    "Keep the reply concise and preserve any valid trailing buttons JSON block requested by the system prompt."
});

const supportCliPair =
  provider === "codex"
    ? withAgentFallback(codex, claude, { label: "runyard-support-agent" })
    : withAgentFallback(claude, codex, { label: "runyard-support-agent" });

const supportAgent =
  provider === "pi"
    ? withAgentFallback(
        createPiAgentFromEnv({
          PiAgent,
          workflow: "SUPPORT",
          timeoutMs: 2 * 60 * 1000,
          systemPrompt:
            "You are answering inside Runyard's floating support chat. Return only JSON with a string field named reply. " +
            "Keep the reply concise and preserve any valid trailing buttons JSON block requested by the system prompt."
        }),
        supportCliPair,
        { label: "runyard-support-agent" }
      )
    : supportCliPair;

function transcript(messages: Array<{ role?: string; content?: string }>) {
  return messages
    .slice(-24)
    .map((message) => `${message.role || "user"}: ${message.content || ""}`)
    .join("\n\n");
}

export default smithers((ctx) => (
  <Workflow name="runyard-support-agent">
    <Task id="support" output={outputs.support} agent={supportAgent} timeoutMs={2 * 60 * 1000}>
      {`${ctx.input.system || "You are the Runyard support agent."}\n\n` +
        `--- Conversation ---\n${transcript(ctx.input.messages as any)}\n\n` +
        `Return JSON {"reply":"..."} with the exact user-facing response in reply.`}
    </Task>
  </Workflow>
));
