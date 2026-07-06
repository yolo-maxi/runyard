import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWorkflowPackage,
  finalizeImportedCapability,
  validateWorkflowPackage,
  workflowPackageFilename,
  workflowPackageImportPlan
} from "../src/workflowPackage.js";

const capability = {
  slug: "hello-flow",
  name: "Hello Flow",
  description: "Says hello",
  category: "Demo",
  keywords: ["hello"],
  inputSchema: { type: "object", required: ["name"] },
  outputSchema: { type: "object" },
  requiredRunnerTags: ["local"],
  requiredSkills: [],
  requiredAgents: [],
  approvalPolicy: {},
  supervision: {},
  workflow: { entry: "hello-flow.tsx", requiredSecrets: ["HELLO_TOKEN"], hooks: { allowedProfiles: ["webhook"] } },
  maxRunMinutes: 10,
  version: 3,
  enabled: true
};

const source = {
  relativePath: "workflow-templates/workflows/hello-flow.tsx",
  language: "tsx",
  code: "// smithers-display-name: Hello Flow\nexport default null;\n"
};

describe("workflow package helpers", () => {
  it("builds immutable file packages without local bundle ids or enabled state", () => {
    const pkg = buildWorkflowPackage({
      capability: { ...capability, workflow: { ...capability.workflow, bundleId: "wfb_local" } },
      source,
      exportedAt: "2026-07-06T00:00:00.000Z",
      exportedBy: "operator",
      hubVersion: "0.3.5"
    });

    assert.equal(pkg.schema, "runyard.workflow-package.v1");
    assert.equal(pkg.capability.slug, "hello-flow");
    assert.equal(pkg.capability.enabled, false);
    assert.equal(pkg.capability.workflow.bundleId, undefined);
    assert.equal(pkg.workflow.code, source.code);
    assert.match(pkg.workflow.sha256, /^[0-9a-f]{64}$/);
    assert.match(pkg.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(pkg.requirements.declaredSecrets, ["HELLO_TOKEN"]);
    assert.deepEqual(pkg.requirements.hooks, ["webhook"]);
    assert.equal(workflowPackageFilename(pkg.capability.slug, pkg.contentHash).endsWith(".runyard-workflow.json"), true);
  });

  it("validates package hashes and plans disabled imports", () => {
    const pkg = buildWorkflowPackage({ capability, source, exportedAt: "2026-07-06T00:00:00.000Z" });
    const validation = validateWorkflowPackage(pkg);
    assert.equal(validation.ok, true);
    assert.equal(validation.report.valid, true);
    assert.equal(validation.report.installEnabled, false);

    const plan = workflowPackageImportPlan(pkg, { slugOverride: "imported-flow" });
    assert.equal(plan.ok, true);
    assert.equal(plan.report.targetSlug, "imported-flow");
    assert.equal(plan.capability.enabled, false);
    assert.equal(plan.capability.workflow.bundleId, "__WORKFLOW_BUNDLE_ID__");

    const finalized = finalizeImportedCapability(plan.capability, {
      id: "wfb_1",
      version: 1,
      sha256: pkg.workflow.sha256
    });
    assert.equal(finalized.enabled, false);
    assert.equal(finalized.workflow.bundleId, "wfb_1");
    assert.equal(finalized.workflow.sharedPackage.bundleSha256, pkg.workflow.sha256);
  });

  it("rejects tampered workflow packages", () => {
    const pkg = buildWorkflowPackage({ capability, source, exportedAt: "2026-07-06T00:00:00.000Z" });
    const tampered = { ...pkg, workflow: { ...pkg.workflow, code: `${pkg.workflow.code}\n// changed\n` } };
    const validation = validateWorkflowPackage(tampered);
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join("\n"), /sha256/);
    assert.match(validation.errors.join("\n"), /contentHash/);
  });
});
