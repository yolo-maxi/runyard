// smithers-source: authored
// smithers-display-name: Implement
// smithers-description: Runs an implementation agent, then a validation pass, and returns structured implementation notes.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, ClaudeCodeAgent } from "smithers-orchestrator";
import { z } from "zod/v4";

const REPO = process.env.IMPLEMENT_REPO_DIR || process.cwd();

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

const builder = new ClaudeCodeAgent({
  model: "claude-opus-4-7",
  cwd: REPO,
  dangerouslySkipPermissions: true,
  timeoutMs: 45 * 60 * 1000,
  systemPrompt:
    "You are an implementation agent working inside a git repository. Inspect the codebase first, keep edits scoped, preserve unrelated changes, and run focused verification when practical. Do not commit or push."
});

const validator = new ClaudeCodeAgent({
  model: "claude-sonnet-4-6",
  cwd: REPO,
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  timeoutMs: 20 * 60 * 1000,
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
