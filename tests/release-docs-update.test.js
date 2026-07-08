import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { defaultWorkflowEndpointSeeds } from "../src/dbBootstrap.js";
import { seedCapabilities } from "../src/seedCatalog.js";
import { WORKFLOW_TEMPLATE_INCLUDE_PATHS } from "../src/workflowTemplateIncludes.js";
import { workflowEndpointRunInput } from "../src/workflowEndpointSubmission.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("release docs-update: seeded workflow + endpoint", () => {
  const capability = seedCapabilities.find((seed) => seed.slug === "docs-update");
  const endpoint = defaultWorkflowEndpointSeeds.find((seed) => seed.slug === "release-docs-update");

  it("ships the repo-agnostic docs-update capability", () => {
    assert.ok(capability, "docs-update capability seed missing");
    const properties = capability.inputSchema.properties;
    // The repo-agnostic contract: every repo-specific fact is an input.
    for (const field of ["repo", "repoDir", "docsPath", "docsFramework", "fromRef", "toRef", "updateMode", "adapter", "payload"]) {
      assert.ok(properties[field], `docs-update input schema missing ${field}`);
    }
    assert.deepEqual(properties.updateMode.enum, ["propose", "apply"]);
    assert.equal(properties.updateMode.default, "propose");
    assert.equal(capability.workflow.entry, ".smithers/workflows/docs-update.tsx");
  });

  it("ships the workflow template and its lib, both synced to runner workspaces", () => {
    for (const file of ["workflow-templates/workflows/docs-update.tsx", "workflow-templates/workflows/docs-update-lib.js"]) {
      assert.ok(existsSync(path.join(repoRoot, file)), `${file} missing`);
      assert.ok(WORKFLOW_TEMPLATE_INCLUDE_PATHS.includes(file), `${file} not in WORKFLOW_TEMPLATE_INCLUDE_PATHS`);
    }
  });

  it("seeds the release-docs-update endpoint with payload mode and Runyard-only config", () => {
    assert.ok(endpoint, "release-docs-update endpoint seed missing");
    assert.equal(endpoint.capabilitySlug, "docs-update");
    assert.equal(endpoint.config.inputMode, "payload");
    assert.equal(endpoint.config.untrustedInput, true);
    // Runyard-specific facts live in the seed config, not in the workflow.
    assert.equal(endpoint.repo, "runyard");
    assert.equal(endpoint.config.input.docsPath, "docs-site/content/docs");
    assert.equal(endpoint.config.input.docsFramework, "fumadocs");
    assert.equal(endpoint.config.input.updateMode, "propose");
    assert.equal(endpoint.secretEnvKey, "releaseDocsUpdateEndpointSecret");
    assert.ok(endpoint.maxPayloadBytes <= 128 * 1024);
    assert.ok(endpoint.rateLimitCount <= 30);
  });
});

describe("release docs-update: trigger payload handling", () => {
  const endpoint = defaultWorkflowEndpointSeeds.find((seed) => seed.slug === "release-docs-update");

  it("maps a GitHub release event into docs-update input", () => {
    const built = workflowEndpointRunInput(
      endpoint,
      {
        title: "Docs update for v0.4.0",
        release: { tag_name: "v0.4.0", html_url: "https://github.com/acme/repo/releases/tag/v0.4.0" },
        repository: { full_name: "acme/repo" }
      },
      { payloadHash: "sha256:test" }
    );
    assert.equal(built.ok, true);
    assert.equal(built.input.docsPath, "docs-site/content/docs");
    assert.equal(built.input.updateMode, "propose");
    assert.equal(built.input.repo, "runyard");
    assert.equal(built.input.payload.release.tag_name, "v0.4.0");
    assert.equal(built.input.payloadHash, "sha256:test");
    assert.match(built.input.title, /v0\.4\.0|Docs update/);
  });

  it("rejects non-object payloads", () => {
    for (const body of [null, [], "text"]) {
      const built = workflowEndpointRunInput(endpoint, body, { payloadHash: "sha256:x" });
      assert.equal(built.ok, false);
      assert.equal(built.code, 400);
    }
  });

  it("keeps the feedback mode contract for endpoints without inputMode", () => {
    const feedbackEndpoint = defaultWorkflowEndpointSeeds.find((seed) => seed.slug === "runyard-mobile-feedback");
    const built = workflowEndpointRunInput(feedbackEndpoint, { feedback: "the button is broken" }, { payloadHash: "sha256:y" });
    assert.equal(built.ok, true);
    assert.match(built.input.context, /UNTRUSTED FEEDBACK/);
  });
});

describe("release docs-update: GitHub Actions trigger", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

  it("declares a docs-update job gated on the published release", () => {
    assert.match(workflow, /docs-update:/);
    const jobIdx = workflow.indexOf("docs-update:");
    const jobBlock = workflow.slice(jobIdx);
    assert.match(jobBlock, /needs: \[release\]/);
    assert.match(jobBlock, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  });

  it("uses a secret for the endpoint credential and fails loudly when unset", () => {
    assert.match(workflow, /secrets\.RUNYARD_DOCS_UPDATE_ENDPOINT_SECRET/);
    assert.match(workflow, /::error::RUNYARD_DOCS_UPDATE_ENDPOINT_SECRET/);
    assert.match(workflow, /exit 1/);
    // The secret must never be inlined.
    assert.doesNotMatch(workflow, /Bearer shub_/);
    assert.match(workflow, /curl --fail-with-body/);
  });

  it("posts to the seeded endpoint path", () => {
    assert.match(workflow, /\/api\/workflow-endpoints\/release-docs-update/);
  });
});
