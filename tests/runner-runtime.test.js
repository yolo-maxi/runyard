import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeRunnerLoad,
  authOkFor,
  hasClaimCapacity,
  isSupervisorCapability,
  materializeAgentRuntimePack,
  materializeWorkflowBundle,
  preflightAssignment,
  preflightImproveRepo,
  supervisorConcurrencyLimit
} from "../src/runnerRuntime.js";
import { workflowBundleSha256 } from "../src/workflowBundleRecords.js";

describe("runner runtime helpers", () => {
  it("classifies supervisor capability and capacity pools", () => {
    assert.equal(isSupervisorCapability({ slug: "run-smithers" }), true);
    assert.equal(isSupervisorCapability({ slug: "hello" }), false);
    const kinds = new Map([
      ["run_1", "work"],
      ["run_2", "supervisor"],
      ["run_3", "work"]
    ]);
    assert.deepEqual(activeRunnerLoad(kinds), { work: 2, supervisors: 1 });
    assert.equal(supervisorConcurrencyLimit(4, 0.5), 2);
    assert.equal(hasClaimCapacity(kinds, 2, 1), true);
    assert.equal(hasClaimCapacity(new Map([["a", "work"], ["b", "supervisor"]]), 1, 1), false);
  });

  it("reports missing CLI auth only when a capability needs that provider", () => {
    assert.deepEqual(authOkFor({ slug: "hello" }, { claude: { ok: false }, codex: { ok: false } }), []);
    assert.deepEqual(authOkFor(
      { slug: "improve", requiredAgents: ["implementation-agent"], workflow: {} },
      { claude: { ok: false, error: "login required" }, codex: { ok: true } }
    ), ["claude: login required"]);
    assert.deepEqual(authOkFor(
      { slug: "codex-workflow", workflow: { engine: "codex" } },
      { codex: { ok: false } }
    ), ["codex: not authenticated"]);
  });

  it("preflights workflow entry, auth, and improve repo resolution", () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "runner-runtime-"));
    assert.deepEqual(preflightAssignment({}, { slug: "hello" }, "", { workspace: temp, health: {} }), [
      "capability hello has no workflow.entry"
    ]);
    assert.match(preflightAssignment({}, { slug: "hello" }, "missing.tsx", { workspace: temp, health: {} })[0], /workflow file not found/);
    assert.match(preflightImproveRepo({ input: {} }, { slug: "improve" }, {
      workspace: temp,
      env: {},
      gitBin: "false"
    })[0], /improve repo preflight failed/);
  });

  it("materializes runtime packs to a private file and compact env summary", () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "runner-runtime-pack-"));
    const env = materializeAgentRuntimePack(
      { id: "run_1" },
      {
        schemaVersion: 1,
        capturedAt: "2026-01-01T00:00:00.000Z",
        capability: { slug: "improve" },
        agents: [{ slug: "pm", version: 2, instructions: "large" }],
        skills: [{ slug: "review", version: 3, body: "large" }]
      },
      { workspace: temp }
    );

    assert.match(env.RUNYARD_AGENT_RUNTIME_PACK_FILE, /run_1\.agent-runtime\.json$/);
    assert.deepEqual(JSON.parse(readFileSync(env.RUNYARD_AGENT_RUNTIME_PACK_FILE, "utf8")).agents[0], {
      slug: "pm",
      version: 2,
      instructions: "large"
    });
    assert.deepEqual(JSON.parse(env.RUNYARD_AGENT_RUNTIME_PACK), {
      schemaVersion: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
      capability: { slug: "improve" },
      agents: [{ slug: "pm", version: 2 }],
      skills: [{ slug: "review", version: 3 }]
    });
    assert.deepEqual(materializeAgentRuntimePack({ id: "run_2" }, null, { workspace: temp }), {});
  });

  it("materializes DB workflow bundles to an isolated per-run file", () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "runner-workflow-bundle-"));
    const code = "export default function Workflow() {}\n";
    const bundle = { id: "wfb_1", capabilitySlug: "deploy", version: 3, language: "tsx", sha256: workflowBundleSha256(code), code };
    const capability = { slug: "deploy", workflow: { bundleId: "wfb_1" } };

    const materialized = materializeWorkflowBundle({ id: "run_1" }, capability, bundle, { workspace: temp });

    assert.equal(materialized.entry, path.join(temp, ".smithers", "workflow-bundles", "run_1", "wfb_1.v3.tsx"));
    assert.equal(readFileSync(materialized.entry, "utf8"), code);
    assert.equal(materialized.bundleId, "wfb_1");
    assert.equal(materialized.version, 3);
    assert.equal(materialized.sha256, bundle.sha256);
    assert.equal(materialized.sizeBytes, Buffer.byteLength(code, "utf8"));
  });

  it("leaves file-backed workflows untouched and fails closed on bundle gaps", () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "runner-workflow-bundle-"));
    const code = "export default function Workflow() {}\n";
    const bundle = { id: "wfb_1", version: 1, language: "tsx", sha256: workflowBundleSha256(code), code };
    const capability = { slug: "deploy", workflow: { bundleId: "wfb_1" } };

    // File-backed capability: no bundle reference → no materialization at all.
    assert.equal(
      materializeWorkflowBundle({ id: "run_1" }, { slug: "hello", workflow: { entry: "hello.tsx" } }, null, { workspace: temp }),
      null
    );
    // Configured bundle with no payload data must never fall back to a template.
    assert.throws(
      () => materializeWorkflowBundle({ id: "run_1" }, capability, null, { workspace: temp }),
      /carried no bundle code; refusing to fall back/
    );
    // Payload carrying a different bundle than the capability references.
    assert.throws(
      () => materializeWorkflowBundle({ id: "run_1" }, capability, { ...bundle, id: "wfb_other" }, { workspace: temp }),
      /capability deploy references wfb_1/
    );
    // Stored hash disagreeing with the shipped bytes blocks execution.
    assert.throws(
      () => materializeWorkflowBundle({ id: "run_1" }, capability, { ...bundle, sha256: "deadbeef" }, { workspace: temp }),
      /sha256 mismatch/
    );
    // A bundle id outside the store's alphabet must never become a file path.
    assert.throws(
      () => materializeWorkflowBundle(
        { id: "run_1" },
        { slug: "deploy", workflow: { bundleId: "../../escape" } },
        { ...bundle, id: "../../escape" },
        { workspace: temp }
      ),
      /unsupported characters/
    );
  });
});
