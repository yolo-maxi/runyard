import { DatabaseSync } from "node:sqlite";

import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { createRunStore } from "../src/runStore.js";
import { createRunCreateStore } from "../src/runCreateStore.js";
import { createRunMutationStore } from "../src/runMutationStore.js";
import { createScmStore } from "../src/scmStore.js";
import { createCiStore } from "../src/ciStore.js";
import { createCiTriggers } from "../src/ciTriggers.js";
import { createCiOrchestrator } from "../src/ciOrchestrator.js";
import { createCiReporter } from "../src/ciReporter.js";
import { CI_JOB_CAPABILITY_SLUG, CI_PIPELINE_CAPABILITY_SLUG } from "../src/ciCapabilities.js";

// Mini CI hub for unit tests: real in-memory SQLite, the REAL run stores
// (create/mutation/read), the REAL scm/ci stores, and the real trigger/
// orchestrator/reporter modules — only GitHub is fake. Time is deterministic.

export function createCiHarness({ githubFiles = {}, githubApp: githubAppOverride } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DB_SCHEMA_SQL);
  // Mirror initDb's ALTER-added runs columns the CI path depends on
  // (capability versioning / parent linkage are not in the base CREATE).
  db.exec("ALTER TABLE runs ADD COLUMN capability_sha TEXT");
  db.exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT");
  const one = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params));
  const all = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params));
  const run = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params));

  let counter = 0;
  let clockMs = 1750000000000;
  const clock = {
    advance(ms) {
      clockMs += ms;
    },
    nowMs: () => clockMs
  };
  const nowIso = () => new Date((clockMs += 1000)).toISOString();
  const deps = { all, one, run, id: (prefix) => `${prefix}_${++counter}`, now: nowIso };

  for (const slug of [CI_PIPELINE_CAPABILITY_SLUG, CI_JOB_CAPABILITY_SLUG]) {
    run(
      `INSERT INTO capabilities (id, slug, name, workflow, created_at, updated_at)
       VALUES (?, ?, ?, '{"engine":"runyard-ci"}', ?, ?)`,
      [`cap_${slug}`, slug, slug, nowIso(), nowIso()]
    );
  }
  const getCapability = (slug) => {
    const row = one("SELECT * FROM capabilities WHERE slug = ?", [slug]);
    return row
      ? { id: row.id, slug: row.slug, name: row.name, version: row.version, approvalPolicy: {}, workflow: { engine: "runyard-ci" } }
      : null;
  };

  const runStore = createRunStore(deps);
  const events = [];
  const addRunEvent = (runId, type, message = "", data = {}) => {
    events.push({ runId, type, message, data });
    return runStore.addRunEvent(runId, type, message, data);
  };
  const runMutationStore = createRunMutationStore({
    one,
    run,
    now: nowIso,
    getRun: runStore.getRun,
    adjustRunnerActiveRuns: () => {},
    onRunStatusChange: (updatedRun, fromStatus) => {
      if (harness.orchestrator) harness.orchestrator.handleRunStatusChange(updatedRun, fromStatus);
    }
  });
  const runCreateStore = createRunCreateStore({
    run,
    id: deps.id,
    now: nowIso,
    scrubStoredSecrets: (value) => value,
    addRunEvent,
    createApproval: () => {
      throw new Error("CI runs must never require approvals in this harness");
    },
    getRun: runStore.getRun,
    getWorkItem: () => null,
    addWorkItemEvent: () => {}
  });

  const scm = createScmStore(deps);
  const ci = createCiStore(deps);

  // Fake GitHub: contents/commits reads from `githubFiles`, checks captured.
  const checkCalls = [];
  let checkIdCounter = 500;
  const githubApp = githubAppOverride || {
    configured: () => true,
    installationToken: async () => "ghs_fake",
    request: async (method, path) => {
      const contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/([^?]+)\?ref=(.+)$/.exec(path);
      if (contents) {
        const key = `${contents[1]}@${decodeURIComponent(contents[3])}`;
        const text = githubFiles[key];
        if (text === undefined) {
          const error = new Error("Not Found");
          error.status = 404;
          throw error;
        }
        return { status: 200, data: { content: Buffer.from(text).toString("base64"), size: text.length } };
      }
      const commit = /^\/repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(path);
      if (commit) {
        const sha = githubFiles[`resolve:${commit[1]}@${decodeURIComponent(commit[2])}`];
        if (!sha) {
          const error = new Error("Not Found");
          error.status = 404;
          throw error;
        }
        return { status: 200, data: { sha } };
      }
      throw new Error(`fake github: unhandled ${method} ${path}`);
    },
    createCheckRun: async ({ owner, repo, payload }) => {
      const id = ++checkIdCounter;
      checkCalls.push({ op: "create", owner, repo, id, payload });
      return { id };
    },
    updateCheckRun: async ({ owner, repo, checkRunId, payload }) => {
      checkCalls.push({ op: "update", owner, repo, id: Number(checkRunId), payload });
      return { id: Number(checkRunId) };
    }
  };

  const env = {
    baseUrl: "http://hub.test",
    githubAppId: "1234",
    ciDeliveryRetentionMs: 14 * 24 * 60 * 60_000
  };

  const audits = [];
  const recordAudit = (actor, action, target, detail) => audits.push({ actor, action, target, detail });

  const ciTriggers = createCiTriggers({
    env,
    githubApp,
    getScmRepo: scm.getScmRepo,
    getCapability,
    createRun: runCreateStore.createRun,
    transitionRun: runMutationStore.transitionRun,
    addRunEvent,
    recordAudit,
    createCiPipeline: ci.createCiPipeline,
    setCiPipelineRun: ci.setCiPipelineRun,
    listCiJobs: ci.listCiJobs,
    markCiJobPhase: ci.markCiJobPhase,
    getCiJob: ci.getCiJob,
    getCiPipeline: ci.getCiPipeline,
    listActiveCiPipelines: ci.listActiveCiPipelines,
    markCiPipelineSuperseded: ci.markCiPipelineSuperseded,
    getRun: runStore.getRun,
    nowIso,
    logError: () => {}
  });

  const orchestrator = createCiOrchestrator({
    env,
    getCiPipeline: ci.getCiPipeline,
    getCiJob: ci.getCiJob,
    listCiJobs: ci.listCiJobs,
    listActiveCiPipelines: ci.listActiveCiPipelines,
    listOrphanCiPipelines: ci.listOrphanCiPipelines,
    setCiPipelineRun: ci.setCiPipelineRun,
    touchCiPipeline: ci.touchCiPipeline,
    markCiJobDispatched: ci.markCiJobDispatched,
    markCiJobPhase: ci.markCiJobPhase,
    findCiJobRunCandidate: ci.findCiJobRunCandidate,
    lastCiRunEventAt: ci.lastCiRunEventAt,
    getCiJobByRunId: ci.getCiJobByRunId,
    getScmRepo: scm.getScmRepo,
    getCapability,
    createRun: runCreateStore.createRun,
    transitionRun: runMutationStore.transitionRun,
    addRunEvent,
    getRun: runStore.getRun,
    pruneScmWebhookDeliveries: scm.pruneScmWebhookDeliveries,
    nowIso,
    nowMs: clock.nowMs,
    logError: () => {}
  });

  const reporter = createCiReporter({
    env,
    githubApp,
    listRecentCiPipelines: ci.listRecentCiPipelines,
    listActiveCiPipelines: ci.listActiveCiPipelines,
    listCiJobs: ci.listCiJobs,
    getScmRepo: scm.getScmRepo,
    getRun: runStore.getRun,
    updateCiJobCheck: ci.updateCiJobCheck,
    updateCiPipelineCheck: ci.updateCiPipelineCheck,
    nowMs: clock.nowMs,
    logError: () => {}
  });

  const harness = {
    db,
    one,
    all,
    run,
    env,
    clock,
    events,
    audits,
    checkCalls,
    scm,
    ci,
    githubApp,
    ciTriggers,
    orchestrator,
    reporter,
    getRun: runStore.getRun,
    listRuns: runStore.listRuns,
    transitionRun: runMutationStore.transitionRun,
    addRunEvent,
    // Simulate the runner finishing a job run (the runner reports terminal
    // through the run lifecycle endpoints, which funnel to transitionRun).
    finishJobRun(runId, status, extra = {}) {
      runMutationStore.transitionRun(runId, "running", { started_at: nowIso() });
      return runMutationStore.transitionRun(runId, status, { completed_at: nowIso(), ...extra });
    },
    connectRepo(overrides = {}) {
      const repo = scm.upsertScmRepo({
        externalId: 1,
        owner: "yolo-maxi",
        name: "runyard",
        fullName: "yolo-maxi/runyard",
        cloneUrl: "https://github.com/yolo-maxi/runyard.git",
        defaultBranch: "main",
        installationId: "42",
        ...overrides
      });
      scm.setScmRepoEnabled(repo.id, true);
      if (overrides.trustPolicy) scm.setScmRepoTrustPolicy(repo.id, overrides.trustPolicy);
      return scm.getScmRepo(repo.id);
    }
  };
  return harness;
}

export const SAMPLE_CI_YML = `
version: 1
name: ci
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  lint:
    executor: native
    commands: ["pnpm lint"]
  test:
    executor: native
    needs: [lint]
    commands: ["pnpm test"]
    secrets: [NPM_TOKEN]
  docs:
    executor: native
    needs: [lint]
    commands: ["pnpm build:docs"]
    required: false
`;

export function pushTrigger(overrides = {}) {
  return {
    provider: "github",
    event: "push",
    action: "",
    deliveryId: `del-${Math.abs(overrides.seed || 1)}`,
    // Before the harness clock's epoch so freshly-created reruns/dispatches
    // (whose receivedAt is nowIso) always count as newer than this fixture.
    receivedAt: "2025-06-15T00:00:00.000Z",
    repoFullName: "yolo-maxi/runyard",
    ref: "refs/heads/main",
    headSha: "a".repeat(40),
    baseSha: "9".repeat(40),
    sender: "ocean",
    changedPaths: ["src/db.js"],
    deleted: false,
    ...overrides
  };
}

export function prTrigger(overrides = {}) {
  return {
    provider: "github",
    event: "pull_request",
    action: "opened",
    deliveryId: "del-pr-1",
    receivedAt: "2025-06-15T00:00:00.000Z",
    repoFullName: "yolo-maxi/runyard",
    prNumber: 7,
    ref: "feature/x",
    baseRef: "main",
    headSha: "c".repeat(40),
    baseSha: "b".repeat(40),
    sender: "ocean",
    headRepoFullName: "yolo-maxi/runyard",
    draft: false,
    ...overrides
  };
}
