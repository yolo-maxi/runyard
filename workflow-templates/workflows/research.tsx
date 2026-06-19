// smithers-source: authored
// smithers-display-name: Research
// smithers-description: Runs a Smithers research agent and returns a concise sourced brief with key findings.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";

const inputSchema = z.object({
  prompt: z.string().describe("The research question or topic.")
});

const researchOutput = z.looseObject({
  summary: z.string().default(""),
  keyFindings: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([])
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  research: researchOutput
});

export default smithers((ctx) => (
  <Workflow name="research">
    <Task id="research" output={researchOutput} agent={providers.claude}>
      {`Research this topic and return JSON with "summary", "keyFindings", "sources", and "openQuestions".\n\n` +
        `Topic:\n${ctx.input.prompt}`}
    </Task>
  </Workflow>
));
