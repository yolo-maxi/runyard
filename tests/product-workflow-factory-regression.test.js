import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { developmentFactoryDefinition } from "../src/boardDefinition.js";
import { createScheduleHandlers } from "../src/scheduleRoutes.js";
import { lintSmithersWorkflowSource } from "../src/smithersHardening.js";
import { isDeterministicAgentFailure, withAgentFallback } from "../workflow-templates/workflows/agent-fallback.js";

const productWorkflowSource = readFileSync(
  path.join(process.cwd(), "workflow-templates", "workflows", "product-workflow.tsx"),
  "utf8"
);

function productSchedule() {
  return developmentFactoryDefinition().schedules.find((entry) => entry.slug === "runyard-daily-roadmap-shaping");
}

describe("product-workflow factory regression coverage", () => {
  it("keeps product-workflow structured outputs Codex strict-schema compatible", () => {
    assert.deepEqual(
      lintSmithersWorkflowSource(productWorkflowSource).filter((finding) => finding.kind === "loose-output-schema"),
      []
    );
    assert.doesNotMatch(productWorkflowSource, /z\.looseObject/);
    for (const name of ["baselineOut", "researchOut", "featureMapOut", "prioritizeOut", "dispatchOut"]) {
      assert.match(productWorkflowSource, new RegExp(`const ${name} = z\\.object\\(`));
    }
  });

  it('propagates the factory daily roadmap schedule agentHarness:"codex" into dispatched runs', () => {
    const schedule = {
      id: "sched_product",
      name: "board:runyard-development-factory:runyard-daily-roadmap-shaping",
      capabilitySlug: productSchedule().workflow,
      timezone: productSchedule().timezone,
      cron: productSchedule().cron,
      input: productSchedule().input,
      enabled: productSchedule().enabled,
      nextRunAt: "2026-07-21T13:00:00.000Z"
    };
    const dispatched = [];
    const handlers = createScheduleHandlers({
      addRunEvent: () => {},
      dispatchRun: (capability, input, options) => {
        const run = { id: "run_product", capabilitySlug: capability.slug, input, status: "queued" };
        dispatched.push({ capability, input, options, run });
        return { run };
      },
      getCapability: (slug) => ({ slug, enabled: true }),
      recordAudit: () => {},
      recordScheduleFireResult: () => {}
    });

    const result = handlers.runScheduleNow(schedule, { trigger: "ticker", actor: "schedule:sched_product" });

    assert.equal(result.ok, true);
    assert.equal(dispatched[0].capability.slug, "product-workflow");
    assert.equal(dispatched[0].input.agentHarness, "codex");
    assert.equal(dispatched[0].input.execute, true);
    assert.equal(dispatched[0].input.targetBranch, "main");
    assert.equal(dispatched[0].input.maxFeatures, 1);
    assert.deepEqual(dispatched[0].options.origin, {
      type: "schedule",
      label: "schedule: board:runyard-development-factory:runyard-daily-roadmap-shaping",
      scheduleId: "sched_product",
      scheduleName: "board:runyard-development-factory:runyard-daily-roadmap-shaping",
      trigger: "ticker"
    });
  });

  it("forces product-workflow child implementation runs onto isolated review branches", () => {
    const childPayloadSource = productWorkflowSource.slice(
      productWorkflowSource.indexOf("function buildChildPayload"),
      productWorkflowSource.indexOf("function renderReport")
    );
    assert.match(productWorkflowSource, /mutationMode:\s*"parallel"/);
    assert.match(productWorkflowSource, /agentHarness:\s*input\.agentHarness \|\| "codex"/);
    assert.match(productWorkflowSource, /hubJson\(`\/api\/capabilities\/implement-change-gated\/run`/);
    assert.match(productWorkflowSource, /body:\s*\{\s*input:\s*payload,/);
    assert.match(productWorkflowSource, /const childOutputs = out\?\.outputs \|\| out/);
    assert.match(productWorkflowSource, /pushedToMain:\s*false/);
    assert.match(productWorkflowSource, /review branches targeting/);
    assert.doesNotMatch(productWorkflowSource, /pushedToMain:\s*anyPushed/);
    assert.doesNotMatch(childPayloadSource, /\bdeploy\s*:/);
    assert.doesNotMatch(childPayloadSource, /\bpromot(?:e|ion)\s*:/);
  });

  it("treats Hub preflight and budget failures as terminal child outcomes", () => {
    for (const status of ["blocked_by_preflight", "blocked_by_gate", "provider_limited", "budget_exceeded"]) {
      assert.match(productWorkflowSource, new RegExp(`"${status}"`));
    }
  });

  it("bounds deterministic structured-schema/auth failures without suppressing transient retries", async () => {
    assert.equal(
      isDeterministicAgentFailure(new Error("Invalid schema for response_format: additionalProperties must be false")),
      true
    );
    assert.equal(isDeterministicAgentFailure(new Error("Claude authentication expired")), true);
    assert.equal(isDeterministicAgentFailure(new Error("503 upstream overloaded")), false);

    const deterministicCalls = [];
    const deterministic = withAgentFallback(
      {
        cliEngine: "claude-code",
        async generate() {
          deterministicCalls.push("claude");
          throw new Error("Claude authentication expired");
        }
      },
      {
        cliEngine: "codex",
        async generate() {
          deterministicCalls.push("codex");
          throw new Error("Invalid schema for response_format: additionalProperties must be false");
        }
      },
      { label: "product-workflow-regression" }
    );
    await assert.rejects(() => deterministic.generate(), /deterministic provider\/config failures/);
    await assert.rejects(() => deterministic.generate(), /deterministic provider\/config failures/);
    assert.deepEqual(deterministicCalls, ["claude", "codex"]);

    const transientCalls = [];
    const transient = withAgentFallback(
      {
        cliEngine: "codex",
        async generate() {
          transientCalls.push("codex");
          throw new Error("429 rate_limit");
        }
      },
      {
        cliEngine: "claude-code",
        async generate() {
          transientCalls.push("claude");
          throw new Error("503 upstream overloaded");
        }
      },
      { label: "product-workflow-transient-regression" }
    );
    await assert.rejects(() => transient.generate(), /503 upstream overloaded/);
    await assert.rejects(() => transient.generate(), /503 upstream overloaded/);
    assert.deepEqual(transientCalls, ["codex", "claude", "codex", "claude"]);
  });
});
