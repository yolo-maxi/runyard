import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createDbBootstrap, defaultWorkflowEndpointSeeds } from "../src/dbBootstrap.js";
import { workflowBundleSha256 } from "../src/workflowBundleRecords.js";

function createHarness({
  oneRows = [],
  env = {},
  randomToken = () => "generated-token",
  catalogSeeds = {
    skills: [{ slug: "skill" }],
    agents: [{ slug: "agent" }],
    knowledge: [{ slug: "knowledge" }],
    capabilities: [{ slug: "capability", workflow: { bundleId: "wfb_seed" } }]
  },
  workflowBundles = [],
  workflowEndpointSeeds = [
    {
      slug: "feedback",
      capabilitySlug: "improve",
      name: "Feedback"
    }
  ]
} = {}) {
  const calls = [];
  const rows = [...oneRows];
  const bundles = [...workflowBundles];
  const bootstrap = createDbBootstrap({
    one: (sql, params) => {
      calls.push({ fn: "one", sql, params });
      return rows.length ? rows.shift() : null;
    },
    run: (sql, params) => {
      calls.push({ fn: "run", sql, params });
      return { changes: 1 };
    },
    now: () => "2026-07-01T00:00:00.000Z",
    env: {
      dataDir: "/tmp/runyard-test",
      bootstrapToken: "",
      runyardMobileFeedbackEndpointSecret: "",
      ...env
    },
    randomToken,
    createAccessToken: (...args) => calls.push({ fn: "createAccessToken", args }),
    upsertSkill: (input) => calls.push({ fn: "upsertSkill", input }),
    upsertAgent: (input) => calls.push({ fn: "upsertAgent", input }),
    upsertKnowledge: (input) => calls.push({ fn: "upsertKnowledge", input }),
    upsertCapability: (input) => calls.push({ fn: "upsertCapability", input }),
    listWorkflowBundles: ({ capabilitySlug }) => bundles.filter((bundle) => bundle.capabilitySlug === capabilitySlug),
    publishWorkflowBundle: (input) => {
      calls.push({ fn: "publishWorkflowBundle", input });
      const bundle = {
        id: `wfb_${bundles.length + 1}`,
        capabilitySlug: input.capabilitySlug,
        version: bundles.length + 1,
        sha256: "published-sha",
        language: input.language || "tsx",
        sizeBytes: Buffer.byteLength(input.code, "utf8")
      };
      bundles.push(bundle);
      return bundle;
    },
    upsertWorkflowEndpoint: (input, options) => calls.push({ fn: "upsertWorkflowEndpoint", input, options }),
    readOrCreateTokenFileFn: (file, options) => {
      calls.push({ fn: "readOrCreateTokenFile", file, hasOnCreate: Boolean(options.onCreate) });
      return options.createToken();
    },
    log: (message) => calls.push({ fn: "log", message }),
    catalogSeeds,
    workflowEndpointSeeds
  });
  return { bootstrap, bundles, calls };
}

describe("db bootstrap", () => {
  it("sets setting defaults only when missing", () => {
    const missing = createHarness({ oneRows: [null] });

    missing.bootstrap.setSettingDefault("instance_name", "RunYard");

    assert.equal(missing.calls.at(-1).fn, "run");
    assert.deepEqual(missing.calls.at(-1).params, ["instance_name", "RunYard", "2026-07-01T00:00:00.000Z"]);

    const existing = createHarness({ oneRows: [{ key: "instance_name" }] });
    existing.bootstrap.setSettingDefault("instance_name", "RunYard");

    assert.equal(existing.calls.some((call) => call.fn === "run"), false);
  });

  it("creates the bootstrap token once and writes the token file", () => {
    const { bootstrap, calls } = createHarness({
      oneRows: [{ count: 0 }],
      env: { dataDir: "/srv/runyard", bootstrapToken: "configured-token" }
    });

    bootstrap.ensureBootstrapToken();

    assert.deepEqual(calls.find((call) => call.fn === "createAccessToken").args, [
      "bootstrap-admin",
      "configured-token",
      ["admin", "api", "runner", "mcp"]
    ]);
    assert.equal(calls.find((call) => call.fn === "readOrCreateTokenFile").file, path.join("/srv/runyard", "bootstrap-token.txt"));
    assert.match(calls.find((call) => call.fn === "log").message, /bootstrap token written/);
  });

  it("skips bootstrap token creation when an access token already exists", () => {
    const { bootstrap, calls } = createHarness({ oneRows: [{ count: 1 }] });

    bootstrap.ensureBootstrapToken();

    assert.equal(calls.some((call) => call.fn === "createAccessToken"), false);
    assert.equal(calls.some((call) => call.fn === "readOrCreateTokenFile"), false);
  });

  it("seeds catalog records through the configured stores", () => {
    const { bootstrap, calls } = createHarness();

    bootstrap.seedCatalog();

    assert.deepEqual(calls.map((call) => call.fn), ["upsertSkill", "upsertAgent", "upsertKnowledge", "upsertCapability"]);
  });

  it("publishes seeded workflow source idempotently and upserts the bundle id", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "runyard-seed-bundle-"));
    mkdirSync(path.join(root, "workflow-templates", "workflows"), { recursive: true });
    const code = "// smithers-display-name: Seeded\nexport default null;\n";
    writeFileSync(path.join(root, "workflow-templates", "workflows", "seeded.tsx"), code);
    const expectedSha = workflowBundleSha256(code);
    const { bootstrap, calls } = createHarness({
      env: { root },
      workflowBundles: [{ id: "wfb_existing", capabilitySlug: "seeded", version: 7, sha256: expectedSha }],
      catalogSeeds: {
        skills: [],
        agents: [],
        knowledge: [],
        capabilities: [{ slug: "seeded", name: "Seeded", workflow: { engine: "smithers", entry: ".smithers/workflows/seeded.tsx" } }]
      }
    });

    bootstrap.seedCatalog();

    assert.equal(calls.some((call) => call.fn === "publishWorkflowBundle"), false);
    const upsert = calls.find((call) => call.fn === "upsertCapability");
    assert.equal(upsert.input.workflow.bundleId, "wfb_existing");
    assert.equal(upsert.input.workflow.entry, ".smithers/workflows/seeded.tsx");
    assert.equal(upsert.input.workflow.code, undefined);
  });

  it("creates secrets only for new seeded workflow endpoints", () => {
    const { bootstrap, calls } = createHarness({
      oneRows: [null],
      env: { dataDir: "/srv/runyard" },
      randomToken: () => "endpoint-secret"
    });

    bootstrap.seedWorkflowEndpoints();

    const tokenFile = calls.find((call) => call.fn === "readOrCreateTokenFile");
    assert.equal(tokenFile.file, path.join("/srv/runyard", "workflow-endpoints", "feedback-secret.txt"));
    const upsert = calls.find((call) => call.fn === "upsertWorkflowEndpoint");
    assert.equal(upsert.input.slug, "feedback");
    assert.deepEqual(upsert.options, { secret: "endpoint-secret" });
  });

  it("preserves existing workflow endpoint secrets unless an env secret overrides them", () => {
    const existing = createHarness({ oneRows: [{ id: "wend_1" }] });
    existing.bootstrap.seedWorkflowEndpoints();
    assert.equal(existing.calls.some((call) => call.fn === "readOrCreateTokenFile"), false);
    assert.deepEqual(existing.calls.find((call) => call.fn === "upsertWorkflowEndpoint").options, {});

    const overridden = createHarness({
      oneRows: [{ id: "wend_1" }],
      env: { runyardMobileFeedbackEndpointSecret: "env-secret" }
    });
    overridden.bootstrap.seedWorkflowEndpoints();
    assert.deepEqual(overridden.calls.find((call) => call.fn === "upsertWorkflowEndpoint").options, { secret: "env-secret" });
  });

  it("seeds the default workflow endpoints with their capabilities", () => {
    const byCapability = Object.fromEntries(defaultWorkflowEndpointSeeds.map((seed) => [seed.slug, seed.capabilitySlug]));
    assert.equal(byCapability["runyard-mobile-feedback"], "improve");
    assert.equal(byCapability["release-docs-update"], "docs-update");
  });
});
