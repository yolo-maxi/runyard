// smithers-source: authored
// smithers-display-name: Hello (proof)
// smithers-description: Minimal proof workflow — runs the local Claude Code CLI and returns structured output.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";

const helloOutput = z.looseObject({
  answer: z.string(),
  wordCount: z.number(),
});

const inputSchema = z.object({
  topic: z.string().default("durable AI workflows"),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  hello: helloOutput,
});

export default smithers((ctx) => (
  <Workflow name="hello">
    <Task id="hello" output={helloOutput} agent={providers.claude}>
      {`Write a single vivid sentence about ${ctx.input.topic}. ` +
        `Return JSON with "answer" (the sentence) and "wordCount" (number of words in it).`}
    </Task>
  </Workflow>
));
