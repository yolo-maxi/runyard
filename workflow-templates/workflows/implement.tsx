// smithers-source: authored
// smithers-display-name: Implement
// smithers-description: Runs an implementation agent, then a validation pass, and returns structured implementation notes.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent, CodexAgent, PiAgent } from "smithers-orchestrator";
import { z } from "zod/v4";
import { withAgentFallback } from "./agent-fallback.js";
import { createPiAgentFromEnv, resolveAgentCli } from "./pi-harness.js";

const REPO = process.env.IMPLEMENT_REPO_DIR || process.cwd();
const IMPLEMENT_AGENT_CLI = resolveAgentCli(process.env, { workflow: "IMPLEMENT", fallback: "codex" });

const inputSchema = z.object({
  prompt: z.string().describe("What to implement.")
});

const implementOutput = z.looseObject({
  summary: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  notes: z.string().default("")
});

const validateOutput = z.looseObject({
  summary: z.string().default(""),
  testsRun: z.array(z.string()).default([]),
  residualRisks: z.array(z.string()).default([])
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutput,
  validate: validateOutput
});

function makeAgents({ label, claudeModel, codexModel, systemPrompt, claudeAllowedTools }) {
  const claude = new ClaudeCodeAgent({
    model: claudeModel,
    cwd: REPO,
    ...(claudeAllowedTools ? { allowedTools: claudeAllowedTools } : { dangerouslySkipPermissions: true }),
    timeoutMs: label === "validate" ? 20 * 60 * 1000 : 45 * 60 * 1000,
    systemPrompt
  });
  const codex = new CodexAgent({
    ...(codexModel ? { model: codexModel } : {}),
    cwd: REPO,
    sandbox: claudeAllowedTools ? "read-only" : "danger-full-access",
    nativeStructuredOutput: true,
    timeoutMs: label === "validate" ? 20 * 60 * 1000 : 45 * 60 * 1000,
    systemPrompt
  });
  const cliPair =
    IMPLEMENT_AGENT_CLI === "claude"
      ? withAgentFallback(claude, codex, { label })
      : withAgentFallback(codex, claude, { label });
  if (IMPLEMENT_AGENT_CLI !== "pi") return cliPair;
  const pi = createPiAgentFromEnv({
    PiAgent,
    workflow: "IMPLEMENT",
    cwd: REPO,
    systemPrompt,
    timeoutMs: label === "validate" ? 20 * 60 * 1000 : 45 * 60 * 1000
  });
  return withAgentFallback(pi, cliPair, { label });
}

const builder = makeAgents({
  label: "implement",
  claudeModel:
    process.env.RUNYARD_IMPLEMENT_CLAUDE_MODEL ||
    (IMPLEMENT_AGENT_CLI === "claude" ? process.env.RUNYARD_IMPLEMENT_AGENT_MODEL : "") ||
    "claude-opus-4-7",
  codexModel:
    process.env.RUNYARD_IMPLEMENT_CODEX_MODEL ||
    (IMPLEMENT_AGENT_CLI !== "claude" ? process.env.RUNYARD_IMPLEMENT_AGENT_MODEL : ""),
  systemPrompt:
    "You are an implementation agent working inside a git repository. Inspect the codebase first, keep edits scoped, preserve unrelated changes, and run focused verification when practical. Do not commit or push."
});

const validator = makeAgents({
  label: "validate",
  claudeModel: process.env.RUNYARD_VALIDATE_CLAUDE_MODEL || "claude-sonnet-4-6",
  codexModel: process.env.RUNYARD_VALIDATE_CODEX_MODEL || "",
  claudeAllowedTools: ["Read", "Grep", "Glob", "Bash"],
  systemPrompt:
    "You validate an implementation after edits. Inspect the diff and relevant tests. Report behavior covered, commands run, and remaining risks. Do not modify files."
});

export default smithers((ctx) => {
  const implementation = ctx.outputMaybe("implement", { nodeId: "implement" });

  return (
    <Workflow name="implement">
      <Sequence>
        <Task id="implement" output={outputs.implement} agent={builder} timeoutMs={45 * 60 * 1000}>
          {`Implement this request in the repository at ${REPO}. Do not commit or push.\n\n` +
            `Request:\n${ctx.input.prompt}\n\n` +
            `Return JSON {"summary","changedFiles","notes"}.`}
        </Task>

        {implementation && (
          <Task id="validate" output={outputs.validate} agent={validator} timeoutMs={20 * 60 * 1000}>
            {`Validate the implementation for this request:\n${ctx.input.prompt}\n\n` +
              `Implementation summary:\n${implementation.summary || "(no summary)"}\n\n` +
              `Return JSON {"summary","testsRun","residualRisks"}.`}
          </Task>
        )}
      </Sequence>
    </Workflow>
  );
});
