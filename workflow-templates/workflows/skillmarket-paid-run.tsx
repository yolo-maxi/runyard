// smithers-source: authored
// smithers-display-name: SkillMarket paid run
// smithers-description: Deterministic live paid-run workflow used by SkillMarket staging.
/** @jsxImportSource smithers-orchestrator */
import { createHash } from "node:crypto";
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";

const moneySchema = z.looseObject({
  amountMicros: z.string().optional(),
  currency: z.string().optional()
});

const inputSchema = z.object({
  orderId: z.string().min(3),
  packageId: z.string().min(3),
  packageVersion: z.string().min(1),
  quoteId: z.string().min(3),
  inputHash: z.string().min(8),
  maxAuthorizedSpend: moneySchema
});

const runOut = z.object({
  outputHash: z.string(),
  completedAt: z.string(),
  summary: z.string()
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  run: runOut
});

function outputHash(input: z.infer<typeof inputSchema>): string {
  return createHash("sha256")
    .update(JSON.stringify({
      orderId: input.orderId,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      quoteId: input.quoteId,
      inputHash: input.inputHash
    }))
    .digest("hex");
}

export default smithers((ctx) => (
  <Workflow name="skillmarket-paid-run">
    <Sequence>
      <Task id="run" output={outputs.run}>
        {async () => ({
          outputHash: outputHash(ctx.input),
          completedAt: new Date().toISOString(),
          summary: `Live RunYard paid run completed for ${ctx.input.packageId}@${ctx.input.packageVersion}.`
        })}
      </Task>
    </Sequence>
  </Workflow>
));
