import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRunClaimStore } from "../src/runClaimStore.js";

const runner = {
  id: "runner_1",
  name: "Runner",
  online: true,
  capacity: 2,
  tags: ["smithers"]
};

const capability = {
  slug: "deploy",
  name: "Deploy",
  requiredRunnerTags: ["smithers"],
  workflow: { secrets: ["API_KEY"] }
};

const queuedRun = {
  id: "run_1",
  capabilitySlug: "deploy",
  runnerId: null,
  input: { API_KEY: "name" }
};

function createHarness(overrides = {}) {
  const events = [];
  const releases = [];
  const calls = [];
  const capabilities = new Map([
    ["deploy", capability],
    ["run-smithers", { slug: "run-smithers", name: "Run Smithers", requiredRunnerTags: [] }]
  ]);
  const store = createRunClaimStore({
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: overrides.claimChanges ?? 1 };
    },
    now: () => "2026-07-01T00:00:00.000Z",
    getRunner: () => overrides.runner === undefined ? runner : overrides.runner,
    supervisorPoolSize: () => overrides.supervisorCapacity ?? 2,
    runnerLoad: () => overrides.load || { work: 0, supervisors: 0 },
    listRuns: () => overrides.runs || [queuedRun],
    getCapability: (slug) => overrides.capability || capabilities.get(slug),
    adjustRunnerActiveRuns: (...args) => releases.push(args),
    addRunEvent: (...args) => events.push(args),
    getRun: (id) => ({ ...queuedRun, id, input: overrides.claimedInput || { secretNames: ["API_KEY"] } }),
    getDecryptedSecretEnv: (names) => names.includes("API_KEY") ? { API_KEY: "secret-value" } : {},
    buildAgentRuntimePack: () => ({
      schemaVersion: 1,
      capturedAt: "2026-07-01T00:00:00.000Z",
      agents: [{ slug: "agent", version: 3 }],
      skills: [{ slug: "skill", version: 4 }],
      missing: []
    }),
    getWorkflowBundle: overrides.getWorkflowBundle,
    supervisorCapabilitySlug: "run-smithers"
  });
  return { calls, events, releases, store };
}

describe("run claim store", () => {
  it("claims a matching queued run and returns runtime payload details", () => {
    const { calls, events, releases, store } = createHarness();

    const payload = store.claimNextRun("runner_1");

    assert.equal(payload.run.id, "run_1");
    assert.equal(payload.capability.slug, "deploy");
    assert.deepEqual(payload.secretEnv, { API_KEY: "secret-value" });
    assert.equal(payload.agentRuntimePack.agents[0].slug, "agent");
    assert.equal(payload.workflowBundle, undefined);
    assert.deepEqual(releases, [["runner_1", 1]]);
    assert.deepEqual(events.map((event) => event[1]), ["run.assigned", "run.agent_runtime_pack"]);
    assert.equal(calls[0].params[0], "runner_1");
    assert.equal(calls[0].params[3], "run_1");
  });

  it("returns null for offline runners, saturated pools, and CAS misses", () => {
    assert.equal(createHarness({ runner: null }).store.claimNextRun("runner_1"), null);
    assert.equal(createHarness({ runner: { ...runner, online: false } }).store.claimNextRun("runner_1"), null);
    assert.equal(createHarness({ load: { work: 2, supervisors: 2 }, supervisorCapacity: 2 }).store.claimNextRun("runner_1"), null);
    assert.equal(createHarness({ claimChanges: 0 }).store.claimNextRun("runner_1"), null);
  });

  it("skips runs targeted to other runners and unmatched capabilities", () => {
    const targetedAway = { ...queuedRun, id: "run_other", runnerId: "runner_2" };
    const runnable = { ...queuedRun, id: "run_2", runnerId: null };

    assert.equal(createHarness({ runs: [targetedAway, runnable] }).store.claimNextRun("runner_1").run.id, "run_2");
    assert.equal(createHarness({ capability: { ...capability, requiredRunnerTags: ["gpu"] } }).store.claimNextRun("runner_1"), null);
  });

  it("ships DB workflow bundle data with the claim for bundle-backed capabilities", () => {
    const bundle = {
      id: "wfb_1",
      capabilitySlug: "deploy",
      version: 2,
      language: "tsx",
      sizeBytes: 22,
      sha256: "abc123",
      code: "export default null;\n"
    };
    const { events, store } = createHarness({
      capability: { ...capability, workflow: { ...capability.workflow, bundleId: "wfb_1" } },
      getWorkflowBundle: (bundleId, options) => (bundleId === "wfb_1" && options?.includeCode ? bundle : null)
    });

    const payload = store.claimNextRun("runner_1");

    assert.deepEqual(payload.workflowBundle, bundle);
    const bundleEvent = events.find((event) => event[1] === "run.workflow_bundle");
    assert.deepEqual(bundleEvent[3], { bundleId: "wfb_1", version: 2, sha256: "abc123", sizeBytes: 22 });
    assert.equal(JSON.stringify(bundleEvent[3]).includes("export default"), false);
  });

  it("claims but flags a missing configured bundle so the runner fails closed", () => {
    const { events, store } = createHarness({
      capability: { ...capability, workflow: { ...capability.workflow, bundleId: "wfb_gone" } },
      getWorkflowBundle: () => null
    });

    const payload = store.claimNextRun("runner_1");

    assert.equal(payload.workflowBundle, undefined);
    const missingEvent = events.find((event) => event[1] === "run.workflow_bundle_missing");
    assert.deepEqual(missingEvent[3], { bundleId: "wfb_gone" });
  });

  it("uses the supervisor pool separately from work capacity", () => {
    const supervisorRun = { ...queuedRun, id: "run_sup", capabilitySlug: "run-smithers" };

    assert.equal(createHarness({
      load: { work: 2, supervisors: 0 },
      runs: [queuedRun, supervisorRun],
      supervisorCapacity: 1
    }).store.claimNextRun("runner_1").run.id, "run_sup");

    assert.equal(createHarness({
      load: { work: 0, supervisors: 1 },
      runs: [supervisorRun],
      supervisorCapacity: 1
    }).store.claimNextRun("runner_1"), null);
  });
});
