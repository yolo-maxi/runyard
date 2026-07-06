// smithers-source: authored
// smithers-display-name: RunYard smoke check
// smithers-description: Cheap golden smoke workflow for Hub -> runner -> Smithers -> output plumbing.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  label: z.string().default("manual"),
  expectRunner: z.boolean().default(true)
});

const smokeOut = z.looseObject({
  ok: z.boolean(),
  label: z.string(),
  checkedAt: z.string(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().default("") })),
  summary: z.string()
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  smoke: smokeOut
});

export default smithers((ctx) => (
  <Workflow name="runyard-smoke-check">
    <Sequence>
      <Task id="smoke" output={outputs.smoke}>
        {async () => {
          const checks = [
            { name: "workflow-rendered", ok: true, detail: "Smithers rendered and executed this task." },
            { name: "runner-env", ok: Boolean(process.env.HOME || process.cwd()), detail: process.cwd() },
            { name: "hub-url-configured", ok: Boolean(process.env.RUNYARD_HUB_URL || process.env.SMITHERS_HUB_URL || process.env.HUB_URL), detail: "Hub URL env is available when run by RunYard runner." }
          ];
          const ok = checks.every((check) => check.ok);
          return {
            ok,
            label: ctx.input.label,
            checkedAt: new Date().toISOString(),
            checks,
            summary: ok ? "RunYard smoke check passed." : "RunYard smoke check found missing runner plumbing."
          };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
