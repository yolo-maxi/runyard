import path from "node:path";
import { accessTokenCountQuery } from "./accessTokenRecords.js";
import { readOrCreateTokenFile } from "./localSecretFiles.js";
import {
  settingDefaultInsertQuery,
  settingLookupQuery
} from "./settingsRecords.js";
import { seedAgents, seedCapabilities, seedKnowledge, seedSkills } from "./seedCatalog.js";
import { workflowEndpointSeedLookupQuery } from "./workflowEndpointRecords.js";

export const defaultWorkflowEndpointSeeds = [
  {
    slug: "runyard-mobile-feedback",
    name: "Runyard mobile/app feedback",
    description: "Accepts trusted app-server feedback submissions and queues a constrained improve-no-deploy run for Runyard.",
    capabilitySlug: "improve-no-deploy",
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
    for (const capability of catalogSeeds.capabilities) upsertCapability(capability);
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
      const secret = env.runyardMobileFeedbackEndpointSecret || (existing ? "" : readOrCreateSeededEndpointSecret(endpoint.slug));
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
