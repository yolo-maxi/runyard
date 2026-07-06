import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHubRepairDispatcher,
  createRunDispatcher
} from "../src/runDispatch.js";

function dispatchHarness(overrides = {}) {
  const events = [];
  const created = [];
  const capabilities = new Map([
    ["run-smithers", { slug: "run-smithers", name: "Run Smithers", enabled: true }],
    ["improve", { slug: "improve", name: "Improve", enabled: true, supervision: { default: true } }],
    ["internal", { slug: "internal", name: "Internal", enabled: true, supervision: { default: false } }]
  ]);
  for (const capability of overrides.capabilities || []) capabilities.set(capability.slug, capability);
  const dispatchRun = createRunDispatcher({
    addRunEvent: (runId, type, message, detail) => events.push({ runId, type, message, detail }),
    createRun: (capability, input, options = {}) => {
      const run = { id: `run_${created.length + 1}`, capabilitySlug: capability.slug, input, options };
      created.push({ capability, input, options, run });
      return run;
    },
    findActiveSupervisorByToken: overrides.findActiveSupervisorByToken || (() => null),
    getCapability: (slug) => capabilities.get(slug),
    mintToken: () => "sup_test"
  });
  return { capabilities, created, dispatchRun, events };
}

describe("run dispatcher", () => {
  it("dispatches capabilities directly even when stale supervision flags remain", () => {
    const { created, dispatchRun, events } = dispatchHarness();
    const result = dispatchRun(
      { slug: "improve", name: "Improve", enabled: true, supervision: { default: true } },
      { goal: "polish", target: "app" },
      { requestedBy: "operator", origin: { type: "api" } }
    );

    assert.equal(result.run.capabilitySlug, "improve");
    assert.equal(result.supervising, undefined);
    assert.deepEqual(created[0].input, { goal: "polish", target: "app" });
    assert.deepEqual(events, []);
  });

  it("dispatches verified supervised children directly and strips bypass internals", () => {
    const { created, dispatchRun, events } = dispatchHarness({
      findActiveSupervisorByToken: (token, capabilitySlug) =>
        token === "sup_test" && capabilitySlug === "improve" ? { id: "run_parent", status: "running" } : null
    });

    const result = dispatchRun(
      { slug: "improve", name: "Improve", enabled: true, supervision: { default: true } },
      { target: "app", __supervisedChild: { token: "sup_test" }, __supervisionToken: "internal" },
      { origin: { type: "api" } }
    );

    assert.equal(result.run.capabilitySlug, "improve");
    assert.deepEqual(result.supervisedChild, { parentRunId: "run_parent" });
    assert.deepEqual(created[0].input, { target: "app" });
    assert.equal(created[0].options.origin.type, "run-smithers-child");
    assert.equal(created[0].options.origin.parentRunId, "run_parent");
    assert.deepEqual(events.map((event) => event.type), ["run.supervision.child", "run.supervision.spawned_child"]);
    assert.equal(events[1].runId, "run_parent");
  });

  it("dispatches directly when the supervisor capability is disabled", () => {
    const { capabilities, created, dispatchRun, events } = dispatchHarness();
    capabilities.set("run-smithers", { slug: "run-smithers", enabled: false });

    const result = dispatchRun({ slug: "improve", name: "Improve", supervision: { default: true } }, { target: "app" });

    assert.equal(result.run.capabilitySlug, "improve");
    assert.equal(created[0].capability.slug, "improve");
    assert.deepEqual(events, []);
  });
});

describe("hub repair dispatcher", () => {
  it("creates a direct safety-scoped repair run and records it on the failed run", () => {
    const events = [];
    const created = [];
    const capabilities = new Map([
      ["implement-change-gated", { slug: "implement-change-gated", enabled: true }],
      ["improve", { slug: "improve", workflow: { entry: "workflows/improve.tsx" } }]
    ]);
    const dispatchHubRepair = createHubRepairDispatcher({
      addRunEvent: (runId, type, message, detail) => events.push({ runId, type, message, detail }),
      createRun: (capability, input, options) => {
        const run = { id: "run_repair", capabilitySlug: capability.slug, input, options };
        created.push({ capability, input, options, run });
        return run;
      },
      getCapability: (slug) => capabilities.get(slug),
      repairBranch: "self-repair"
    });

    const runId = dispatchHubRepair(
      {
        id: "run_failed",
        capabilitySlug: "improve",
        input: { repo: "smithers-hub", __execution: { runnerLocation: "local" } },
        runnerId: "runner_1"
      },
      { fingerprint: "TypeError: bad workflow" }
    );

    assert.equal(runId, "run_repair");
    assert.equal(created[0].capability.slug, "implement-change-gated");
    assert.equal(created[0].input.targetBranch, "self-repair");
    assert.equal(created[0].input.repo, "smithers-hub");
    assert.equal(created[0].input.__execution.runnerLocation, "local");
    assert.equal(created[0].options.requestedBy, "system:hub-supervisor");
    assert.equal(created[0].options.runnerId, undefined);
    assert.equal(events[0].runId, "run_failed");
    assert.equal(events[0].type, "run.supervisor.repair_child");
    assert.equal(events[0].detail.repairRunId, "run_repair");
  });
});
