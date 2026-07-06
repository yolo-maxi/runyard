// smithers-source: authored
// smithers-display-name: SkillMarket quote sidecar
// smithers-description: Deterministic live quote sidecar used by SkillMarket staging.
/** @jsxImportSource smithers-orchestrator */
import { createHash } from "node:crypto";
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  packageId: z.string().min(3),
  packageVersion: z.string().min(1),
  inputBytes: z.number().int().nonnegative(),
  declaredInputHash: z.string().min(8),
  requestedAt: z.string()
});

const quoteOut = z.object({
  priceMinMicros: z.string(),
  priceMaxMicros: z.string(),
  assumptions: z.array(z.string()),
  completedAt: z.string()
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  quote: quoteOut
});

function pricedMicros(inputBytes: number, packageId: string): { min: bigint; max: bigint } {
  const fingerprint = createHash("sha256").update(`${packageId}:${inputBytes}`).digest();
  const variability = BigInt(fingerprint[0] ?? 0) * 10n;
  const base = 18_000n + BigInt(Math.ceil(inputBytes / 1024)) * 700n + variability;
  return { min: base, max: base * 2n };
}

export default smithers((ctx) => (
  <Workflow name="skillmarket-quote-sidecar">
    <Sequence>
      <Task id="quote" output={outputs.quote}>
        {async () => {
          const price = pricedMicros(ctx.input.inputBytes, ctx.input.packageId);
          return {
            priceMinMicros: price.min.toString(),
            priceMaxMicros: price.max.toString(),
            assumptions: [
              "Live RunYard quote sidecar executed.",
              `Package ${ctx.input.packageId}@${ctx.input.packageVersion}`,
              `Input hash ${ctx.input.declaredInputHash.slice(0, 12)}`
            ],
            completedAt: new Date().toISOString()
          };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
