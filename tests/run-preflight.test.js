import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  evaluateRunPreflight,
  normalizeRunTitle,
  RUN_PREFLIGHT_BLOCKED,
  RUN_PREFLIGHT_NEEDS_INPUT,
  RUN_PREFLIGHT_READY,
  suggestRunTitle
} from "../src/runPreflight.js";

function capabilityFixture(overrides = {}) {
  return {
    id: "cap_research",
    slug: "research",
    name: "Research",
    enabled: true,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "The research question or topic." },
        depth: { type: "number", description: "How deep to go." }
      }
    },
    requiredRunnerTags: ["smithers"],
    workflow: { engine: "smithers", bundleId: "wfb_research" },
    ...overrides
  };
}

function contextFixture(overrides = {}) {
  return {
    runners: [{ id: "runner_1", name: "vps-1", tags: ["smithers", "vps", "remote"], online: true }],
    hookProfiles: [],
    secretsEnabled: false,
    secretExists: null,
    getWorkflowBundle: () => ({
      id: "wfb_research",
      version: 1,
      language: "tsx",
      sizeBytes: 55,
      sha256: "test-sha",
      code: "// smithers-display-name: Research\nexport default null;\n"
    }),
    root: overrides.root || process.cwd(),
    ...overrides
  };
}

// A root that actually ships the capability's workflow source, so the
// workflow_source check passes instead of warning.
function rootWithWorkflow(entry = "research.tsx") {
  const root = mkdtempSync(path.join(os.tmpdir(), "runyard-preflight-"));
  const workflows = path.join(root, "workflow-templates", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(path.join(workflows, entry), "// smithers-display-name: Research\nexport default null;\n");
  return root;
}

describe("run preflight", () => {
  it("reports ready for complete input with an online matching runner", () => {
    const result = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "quantum computing", title: "  Research  quantum computing  " },
      options: { executionMode: "remote" },
      context: contextFixture({ root: rootWithWorkflow() })
    });

    assert.equal(result.status, RUN_PREFLIGHT_READY);
    assert.equal(result.capability, "research");
    assert.deepEqual(result.questions, []);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.input.title, "Research quantum computing");
    assert.equal(result.execution.mode, "remote");
    assert.match(result.nextAction, /Preflight is green/);
    assert.ok(result.checks.some((check) => check.id === "runner_available" && check.status === "pass"));
    assert.ok(result.checks.some((check) => check.id === "workflow_source" && check.status === "pass"));
  });

  it("blocks custom entry-only workflows when the file source is missing", () => {
    const result = evaluateRunPreflight({
      capability: capabilityFixture({ slug: "deploy-cvm", workflow: { engine: "smithers", entry: ".smithers/workflows/deploy-cvm.tsx" } }),
      input: { prompt: "deploy", title: "Deploy CVM" },
      context: contextFixture({ getWorkflowBundle: () => null })
    });

    assert.equal(result.status, RUN_PREFLIGHT_BLOCKED);
    const blocker = result.blockers.find((entry) => entry.code === "workflow_source_missing");
    assert.match(blocker.message, /provide workflow source bytes or workflow\.bundleId/);
  });

  it("blocks Codex runs whose workflow bundle has loose Smithers output schemas", () => {
    const badBundle = {
      id: "wfb_research",
      version: 1,
      language: "tsx",
      sizeBytes: 240,
      sha256: "test-sha",
      code: `
        const inputSchema = z.object({ prompt: z.string() });
        const researchOut = z.looseObject({ summary: z.string() });
        const { outputs } = createSmithers({
          input: inputSchema,
          research: researchOut
        });
      `
    };

    const result = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "x", title: "T", agentHarness: "codex" },
      context: contextFixture({ getWorkflowBundle: () => badBundle })
    });
    assert.equal(result.status, RUN_PREFLIGHT_BLOCKED);
    const blocker = result.blockers.find((entry) => entry.code === "workflow_schema_invalid");
    assert.match(blocker.message, /additionalProperties:false/);

    const claude = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "x", title: "T", agentHarness: "claude" },
      context: contextFixture({ getWorkflowBundle: () => badBundle, runners: [{ id: "runner_1", tags: ["smithers"], online: true }] })
    });
    assert.equal(claude.blockers.some((entry) => entry.code === "workflow_schema_invalid"), false);
  });

  it("returns needs_input with per-field questions for missing and mistyped input", () => {
    const result = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { depth: "very deep" },
      context: contextFixture()
    });

    assert.equal(result.status, RUN_PREFLIGHT_NEEDS_INPUT);
    assert.deepEqual(result.blockers, []);
    const prompt = result.questions.find((question) => question.field === "prompt");
    assert.equal(prompt.question, "The research question or topic.");
    assert.equal(prompt.expected, "string");
    const depth = result.questions.find((question) => question.field === "depth");
    assert.equal(depth.expected, "number");
    assert.match(result.nextAction, /Answer questions/);
  });

  it("recommends a deterministic title when input.title is missing", () => {
    const result = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "quantum computing" },
      context: contextFixture()
    });

    assert.ok(result.warnings.some((warning) => warning.code === "title_missing"));
    assert.equal(result.suggestedDefaults.title, "Research: quantum computing");
    assert.equal(result.input.title, undefined);
    assert.equal(suggestRunTitle(capabilityFixture(), {}), "Research run");
    assert.equal(normalizeRunTitle("  a\0b\n c  "), "a b c");
  });

  it("blocks on unknown or disabled workflows", () => {
    assert.equal(evaluateRunPreflight({ capability: null }).status, RUN_PREFLIGHT_BLOCKED);
    assert.equal(
      evaluateRunPreflight({ capability: null }).blockers[0].code,
      "workflow_not_found"
    );
    const disabled = evaluateRunPreflight({
      capability: capabilityFixture({ enabled: false }),
      input: { prompt: "x" },
      context: contextFixture()
    });
    assert.equal(disabled.status, RUN_PREFLIGHT_BLOCKED);
    assert.ok(disabled.blockers.some((blocker) => blocker.code === "workflow_disabled"));
  });

  it("blocks when no registered runner matches the required tags or requested location", () => {
    const noTags = evaluateRunPreflight({
      capability: capabilityFixture({ requiredRunnerTags: ["gpu"] }),
      input: { prompt: "x" },
      context: contextFixture()
    });
    assert.equal(noTags.status, RUN_PREFLIGHT_BLOCKED);
    const blocker = noTags.blockers.find((entry) => entry.code === "no_matching_runner");
    assert.deepEqual(blocker.requiredRunnerTags, ["gpu"]);

    const wrongLocation = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "x" },
      options: { executionMode: "local" },
      context: contextFixture()
    });
    assert.ok(wrongLocation.blockers.some((entry) => entry.code === "no_matching_runner"));
  });

  it("warns (not blocks) when matching runners are registered but offline", () => {
    const result = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "x", title: "T" },
      context: contextFixture({
        root: rootWithWorkflow(),
        runners: [{ id: "runner_1", tags: ["smithers"], online: false }]
      })
    });
    assert.equal(result.status, RUN_PREFLIGHT_READY);
    assert.ok(result.warnings.some((warning) => warning.code === "runners_offline"));
  });

  it("blocks on missing required secrets and on a disabled secret store", () => {
    const capability = capabilityFixture({ workflow: { bundleId: "wfb_research", secrets: ["VENICE_API_KEY"] } });
    const disabledStore = evaluateRunPreflight({
      capability,
      input: { prompt: "x" },
      context: contextFixture({ secretsEnabled: false })
    });
    assert.ok(disabledStore.blockers.some((blocker) => blocker.code === "secrets_unavailable"));

    const missing = evaluateRunPreflight({
      capability,
      input: { prompt: "x" },
      context: contextFixture({ secretsEnabled: true, secretExists: () => false })
    });
    const blocker = missing.blockers.find((entry) => entry.code === "missing_secret");
    assert.deepEqual(blocker.secretNames, ["VENICE_API_KEY"]);

    const present = evaluateRunPreflight({
      capability,
      input: { prompt: "x", title: "T" },
      context: contextFixture({ root: rootWithWorkflow(), secretsEnabled: true, secretExists: () => true })
    });
    assert.equal(present.status, RUN_PREFLIGHT_READY);
  });

  it("blocks invalid harness selections and relative repoDir paths", () => {
    const badHarness = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "x", agentHarness: "gemini" },
      context: contextFixture()
    });
    assert.ok(badHarness.blockers.some((blocker) => blocker.code === "harness_selection_invalid"));

    const badRepoDir = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "x", repoDir: "relative/path" },
      context: contextFixture()
    });
    assert.ok(badRepoDir.blockers.some((blocker) => blocker.code === "repo_dir_invalid"));

    const absoluteRepoDir = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "x", repoDir: "/srv/repos/app" },
      context: contextFixture()
    });
    assert.ok(!absoluteRepoDir.blockers.some((blocker) => blocker.code === "repo_dir_invalid"));
    assert.ok(absoluteRepoDir.warnings.some((warning) => warning.code === "repo_dir_manual"));
  });

  it("warns about repo/project selectors outside the configured catalog", () => {
    const result = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: { prompt: "x", repo: "mystery" },
      context: contextFixture({
        repoOptions: [{ value: "runyard", label: "RunYard", selector: "repo" }]
      })
    });
    assert.ok(result.warnings.some((warning) => warning.code === "repo_unknown"));
  });

  it("blocks ineligible post-run hooks with the hook_blocked taxonomy", () => {
    const capability = capabilityFixture({
      workflow: { bundleId: "wfb_research", hooks: { allowedProfiles: ["publish"] } }
    });
    const result = evaluateRunPreflight({
      capability,
      input: { prompt: "x", postRunHooks: ["publish", "rogue"] },
      context: contextFixture({
        hookProfiles: [{ slug: "publish", enabled: true, allowedCapabilities: [] }]
      })
    });
    const blocker = result.blockers.find((entry) => entry.code === "hook_blocked");
    assert.deepEqual(blocker.blocked, ["rogue"]);
    assert.deepEqual(blocker.eligible, ["publish"]);
  });

  it("blocks capabilities with no workflow entry/bundle, missing bundles, and missing entry files", () => {
    const noEntry = evaluateRunPreflight({
      capability: capabilityFixture({ workflow: { engine: "smithers" } }),
      input: { prompt: "x" },
      context: contextFixture()
    });
    assert.ok(noEntry.blockers.some((blocker) => blocker.code === "workflow_entry_missing"));

    const missingBundle = evaluateRunPreflight({
      capability: capabilityFixture({ workflow: { bundleId: "bundle_gone" } }),
      input: { prompt: "x" },
      context: contextFixture({ getWorkflowBundle: () => null })
    });
    const blocker = missingBundle.blockers.find((entry) => entry.code === "workflow_bundle_missing");
    assert.equal(blocker.bundleId, "bundle_gone");

    const missingEntry = evaluateRunPreflight({
      capability: capabilityFixture({ slug: "deploy-cvm", workflow: { entry: ".smithers/workflows/deploy-cvm.tsx" } }),
      input: { prompt: "x", title: "T" },
      context: contextFixture({
        root: mkdtempSync(path.join(os.tmpdir(), "runyard-empty-root-")),
        getWorkflowBundle: () => null
      })
    });
    assert.equal(missingEntry.status, RUN_PREFLIGHT_BLOCKED);
    assert.ok(missingEntry.blockers.some((warning) => warning.code === "workflow_source_missing"));
  });

  it("treats non-object input as a question and unrecognized execution modes as warnings", () => {
    const result = evaluateRunPreflight({
      capability: capabilityFixture(),
      input: "run it please",
      options: { executionMode: "mainframe" },
      context: contextFixture()
    });
    assert.equal(result.status, RUN_PREFLIGHT_NEEDS_INPUT);
    assert.ok(result.questions.some((question) => question.field === "input"));
    assert.ok(result.warnings.some((warning) => warning.code === "execution_mode_unrecognized"));
  });
});
