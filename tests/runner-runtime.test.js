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
  preflightAssignment,
  preflightImproveRepo,
  supervisorConcurrencyLimit
} from "../src/runnerRuntime.js";

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
});
