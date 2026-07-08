import path from "node:path";
import { accessTokenCountQuery } from "./accessTokenRecords.js";
import { readOrCreateTokenFile } from "./localSecretFiles.js";
import {
  settingDefaultInsertQuery,
  settingLookupQuery
} from "./settingsRecords.js";
import { seedAgents, seedCapabilities, seedKnowledge, seedSkills } from "./seedCatalog.js";
import { workflowEndpointSeedLookupQuery } from "./workflowEndpointRecords.js";
import { publishTrustedSeedWorkflowSource } from "./workflowBundlePublishing.js";

export const defaultWorkflowEndpointSeeds = [
  {
    // Generic release-event intake for the repo-agnostic docs-update
    // workflow. Runyard's own GitHub Actions release job posts here; the
    // Runyard-specific facts (repo key, docs path, framework) live in this
    // seed's config — the workflow itself assumes nothing about the repo.
    slug: "release-docs-update",
    name: "Release docs update",
    description: "Accepts release events (e.g. from GitHub Actions) and queues a docs-update run that reads only the diff between the previous and released tags.",
    capabilitySlug: "docs-update",
    repo: "runyard",
    maxPayloadBytes: 64 * 1024,
    rateLimitCount: 10,
    rateLimitWindowMs: 60_000,
    dedupeWindowMs: 10 * 60_000,
    secretEnvKey: "releaseDocsUpdateEndpointSecret",
    config: {
      inputMode: "payload",
      untrustedInput: true,
      input: {
        docsPath: "docs-site/content/docs",
        docsFramework: "fumadocs",
        updateMode: "propose",
        adapter: { buildOutputPaths: ["docs-site/out"] }
      }
    }
  },
  {
    slug: "runyard-mobile-feedback",
    name: "Runyard mobile/app feedback",
    description: "Accepts trusted app-server feedback submissions and queues a constrained improve run for Runyard.",
    capabilitySlug: "improve",
    project: "runyard",
    repo: "runyard",
    maxPayloadBytes: 32 * 1024,
    rateLimitCount: 30,
    rateLimitWindowMs: 60_000,
    dedupeWindowMs: 10 * 60_000,
    config: {
      target: "Runyard mobile/app feedback",
      maxImprovements: 3,
      untrustedInput: true
    }
  }
];

export function createDbBootstrap({
  one,
  run,
  now,
  env,
  randomToken,
  createAccessToken,
  upsertSkill,
  upsertAgent,
  upsertKnowledge,
  upsertCapability,
  publishWorkflowBundle = null,
  listWorkflowBundles = null,
  upsertWorkflowEndpoint,
  readOrCreateTokenFileFn = readOrCreateTokenFile,
  log = console.log,
  catalogSeeds = {
    skills: seedSkills,
    agents: seedAgents,
    knowledge: seedKnowledge,
    capabilities: seedCapabilities
  },
  workflowEndpointSeeds = defaultWorkflowEndpointSeeds
}) {
  function setSettingDefault(key, value) {
    const lookup = settingLookupQuery(key);
    const existing = one(lookup.sql, lookup.params);
    if (existing) return;

    const query = settingDefaultInsertQuery({ key, value, timestamp: now() });
    run(query.sql, query.params);
  }

  function ensureBootstrapToken() {
    const query = accessTokenCountQuery();
    const count = one(query.sql, query.params).count;
    if (count > 0) return;

    const token = env.bootstrapToken || randomToken();
    createAccessToken("bootstrap-admin", token, ["admin", "api", "runner", "mcp"]);
    const tokenFile = path.join(env.dataDir, "bootstrap-token.txt");
    readOrCreateTokenFileFn(tokenFile, { createToken: () => token });
    log(`RunYard bootstrap token written to ${tokenFile}`);
  }

  function seedCatalog() {
    for (const skill of catalogSeeds.skills) upsertSkill(skill);
    for (const agent of catalogSeeds.agents) upsertAgent(agent);
    for (const item of catalogSeeds.knowledge) upsertKnowledge(item);
    for (const capability of catalogSeeds.capabilities) {
      const published = publishTrustedSeedWorkflowSource({
        definition: capability,
        root: env.root,
        publishWorkflowBundle,
        listWorkflowBundles,
        createdBy: "seed"
      });
      upsertCapability(published.definition);
    }
  }

  function seededEndpointSecretPath(slug) {
    return path.join(env.dataDir, "workflow-endpoints", `${slug}-secret.txt`);
  }

  function readOrCreateSeededEndpointSecret(slug) {
    return readOrCreateTokenFileFn(seededEndpointSecretPath(slug), {
      createToken: randomToken,
      onCreate: (file) => log(`Runyard workflow endpoint secret written to ${file}`)
    });
  }

  function seedWorkflowEndpoints() {
    for (const endpoint of workflowEndpointSeeds) {
      const query = workflowEndpointSeedLookupQuery(endpoint.slug);
      const existing = one(query.sql, query.params);
      const secretEnvKey = endpoint.secretEnvKey || "runyardMobileFeedbackEndpointSecret";
      const secret = env[secretEnvKey] || (existing ? "" : readOrCreateSeededEndpointSecret(endpoint.slug));
      upsertWorkflowEndpoint(endpoint, secret ? { secret } : {});
    }
  }

  return {
    setSettingDefault,
    ensureBootstrapToken,
    seedCatalog,
    seedWorkflowEndpoints
  };
}
