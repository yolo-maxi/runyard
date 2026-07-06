// smithers-source: authored
// smithers-display-name: SkillMarket package audit
// smithers-description: Deterministic live package audit used by SkillMarket staging.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  packageId: z.string().min(3),
  packageVersion: z.string().min(1),
  manifestHash: z.string().min(8),
  manifest: z.looseObject({})
});

const checkSchema = z.object({
  id: z.string(),
  status: z.enum(["passed", "warning", "failed"]),
  summary: z.string()
});

const auditOut = z.object({
  checks: z.array(checkSchema),
  completedAt: z.string()
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  audit: auditOut
});

function manifestChecks(manifest: Record<string, unknown>): Array<z.infer<typeof checkSchema>> {
  const entrypoints = manifest.entrypoints && typeof manifest.entrypoints === "object"
    ? manifest.entrypoints as Record<string, unknown>
    : {};
  const limits = manifest.limits && typeof manifest.limits === "object"
    ? manifest.limits as Record<string, unknown>
    : {};
  const egress = manifest.egress && typeof manifest.egress === "object"
    ? manifest.egress as Record<string, unknown>
    : {};

  const checks: Array<z.infer<typeof checkSchema>> = [
    {
      id: "entrypoints.quote",
      status: typeof entrypoints.quote === "string" && entrypoints.quote.length > 0 ? "passed" : "failed",
      summary: "Quote entrypoint is declared."
    },
    {
      id: "entrypoints.run",
      status: typeof entrypoints.run === "string" && entrypoints.run.length > 0 ? "passed" : "failed",
      summary: "Paid-run entrypoint is declared."
    },
    {
      id: "limits.bounded-runtime",
      status: typeof limits.maxRunSeconds === "number" && limits.maxRunSeconds > 0 ? "passed" : "failed",
      summary: "Run time is bounded."
    },
    {
      id: "egress.default-deny",
      status: egress.defaultDeny === true ? "passed" : "warning",
      summary: "Manifest declares default-deny egress policy."
    }
  ];
  return checks;
}

export default smithers((ctx) => (
  <Workflow name="skillmarket-package-audit">
    <Sequence>
      <Task id="audit" output={outputs.audit}>
        {async () => ({
          checks: manifestChecks(ctx.input.manifest),
          completedAt: new Date().toISOString()
        })}
      </Task>
    </Sequence>
  </Workflow>
));
