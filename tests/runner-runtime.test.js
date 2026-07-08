import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeRunnerLoad,
  authOkFor,
  hasClaimCapacity,
  materializeAgentRuntimePack,
  materializeWorkflowBundle,
  preflightAssignment,
  preflightImproveRepo
} from "../src/runnerRuntime.js";
import { workflowBundleSha256 } from "../src/workflowBundleRecords.js";

describe("runner runtime helpers", () => {
  it("tracks direct work capacity", () => {
    const activeRuns = new Set(["run_1", "run_2"]);
    assert.deepEqual(activeRunnerLoad(activeRuns), { work: 2 });
    assert.equal(hasClaimCapacity(activeRuns, 3), true);
    assert.equal(hasClaimCapacity(activeRuns, 2), false);
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
      "workflow hello has no workflow.entry"
    ]);
    assert.match(preflightAssignment({}, { slug: "hello" }, "missing.tsx", { workspace: temp, health: {} })[0], /workflow file not found/);
    assert.match(preflightImproveRepo({ input: {} }, { slug: "improve" }, {
      workspace: temp,
      env: {},
      gitBin: "false"
    })[0], /improve repo preflight failed/);
  });

  it("fails preflight closed on a malformed harness selection, without echoing the value", () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "runner-runtime-"));
    const entry = path.join(temp, "wf.tsx");
    writeFileSync(entry, "// wf");
    const failures = preflightAssignment(
      { input: { piApiKeyEnv: "vk-live-pasted-key" } },
      { slug: "implement", workflow: { entry: "wf.tsx" } },
      entry,
      { workspace: temp, health: {} }
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0], /"piApiKeyEnv"/);
    assert.equal(failures[0].includes("vk-live-pasted-key"), false);

    const clean = preflightAssignment(
      { input: { agentHarness: "pi", piProvider: "venice", piModel: "llama-3.3-70b", piApiKeyEnv: "VENICE_API_KEY" } },
      { slug: "implement", workflow: { entry: "wf.tsx" } },
      entry,
      { workspace: temp, health: {} }
    );
    assert.deepEqual(clean, []);
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

  it("materializes DB workflow bundles as a per-run file inside .smithers/workflows so relative imports resolve like templates", () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "runner-workflow-bundle-"));
    const code = "export default function Workflow() {}\n";
    const bundle = { id: "wfb_1", capabilitySlug: "deploy", version: 3, language: "tsx", sha256: workflowBundleSha256(code), code };
    const capability = { slug: "deploy", workflow: { bundleId: "wfb_1" } };

    const materialized = materializeWorkflowBundle({ id: "run_1" }, capability, bundle, { workspace: temp });

    // Regression guard: bundles used to land in an isolated per-run directory,
    // which broke every bundle-backed workflow importing "./lib.js" or
    // "../agents" (they resolve only from the workflows directory).
    assert.equal(materialized.entry, path.join(temp, ".smithers", "workflows", "wfb_1.v3.run_1.tsx"));
    assert.equal(path.dirname(materialized.entry), path.join(temp, ".smithers", "workflows"));
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
      /workflow deploy references wfb_1/
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
