import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createRunTerminalArtifactService,
  hasRunObstructionAnalysisArtifact
} from "../src/runTerminalArtifacts.js";
import { RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME } from "../src/runObstructionAnalysis.js";

function serviceFixture(overrides = {}) {
  const artifactDir = mkdtempSync(path.join(os.tmpdir(), "runyard-terminal-artifacts-"));
  const artifacts = [];
  const calls = {
    deliveries: [],
    events: [],
    immediate: [],
    reconciled: []
  };
  const run = {
    id: "run_test",
    capabilitySlug: "hello",
    capabilityName: "Hello",
    status: "succeeded",
    createdAt: "2026-06-30T00:00:00.000Z"
  };
  const service = createRunTerminalArtifactService({
    env: { artifactDir, ...overrides.env },
    createArtifact: (artifact) => {
      const stored = { id: `art_${artifacts.length + 1}`, createdAt: "2026-06-30T00:00:01.000Z", ...artifact };
      artifacts.push(stored);
      return stored;
    },
    getRun: (id) => (id === run.id ? run : null),
    listArtifacts: () => artifacts,
    listRunEvents: () => [],
    getCapability: () => ({ slug: "hello", name: "Hello" }),
    withArtifactLinks: (artifact) => ({ ...artifact, deepLink: `/artifact/${artifact.id}` }),
    withRunLinks: (record) => ({ ...record, deepLink: `/run/${record.id}` }),
    withCapabilityLinks: (capability) => ({ ...capability, deepLink: `/cap/${capability.slug}` }),
    summarizeRunEvents: () => ({ totals: { events: 0 } }),
    runDiagnostics: () => null,
    scrubStoredSecrets: (value) => String(value).replace(/secret/g, "[redacted]"),
    addRunEvent: (...args) => calls.events.push(args),
    scheduleRunResponseEndpointDelivery: async (runId) => calls.deliveries.push(runId),
    reconcileRepairChildTerminal: (runId) => calls.reconciled.push(runId),
    reapStuckRunIds: () => ["run_test"],
    scheduleImmediate: (fn) => {
      calls.immediate.push(fn);
      fn();
    },
    ...overrides.deps
  });
  return { artifactDir, artifacts, calls, run, service };
}

describe("run terminal artifact service", () => {
  it("stores text artifacts with safe names and scrubbed content", () => {
    const { artifactDir, artifacts, run, service } = serviceFixture();
    try {
      const artifact = service.storeRunArtifact(run, {
        name: "../bad\nname.txt",
        content: "contains secret",
        mimeType: "text/plain"
      });

      assert.equal(artifact.name, "..-badname.txt");
      assert.equal(readFileSync(artifact.path, "utf8"), "contains [redacted]");
      assert.ok(artifact.path.startsWith(artifactDir));
      assert.equal(artifacts.length, 1);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("records terminal hooks without route-level orchestration", async () => {
    const { artifactDir, artifacts, calls, service } = serviceFixture();
    try {
      const retrospective = service.recordRunTerminalArtifacts("run_test");
      await Promise.all(calls.immediate.map(() => Promise.resolve()));

      assert.ok(retrospective);
      assert.equal(artifacts.some((artifact) => artifact.metadata?.kind === "run-retrospective"), true);
      assert.deepEqual(calls.deliveries, ["run_test"]);
      assert.deepEqual(calls.reconciled, ["run_test"]);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("recognizes obstruction-analysis artifacts by name or metadata kind", () => {
    assert.equal(hasRunObstructionAnalysisArtifact([{ name: RUN_OBSTRUCTION_ANALYSIS_ARTIFACT_NAME }]), true);
    assert.equal(hasRunObstructionAnalysisArtifact([{ metadata: { kind: "run-obstruction-analysis" } }]), true);
    assert.equal(hasRunObstructionAnalysisArtifact([{ name: "other.json" }]), false);
  });
});
