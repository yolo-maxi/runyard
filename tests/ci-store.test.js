import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DB_SCHEMA_SQL } from "../src/dbSchema.js";
import { createCiStore } from "../src/ciStore.js";
import { createScmStore } from "../src/scmStore.js";

// CI pipeline/job store: provenance rows + DAG bookkeeping over real
// in-memory SQLite. Runs rows are inserted directly so the "live status lives
// on runs" join queries are exercised against the real schema.
function createHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DB_SCHEMA_SQL);
  const one = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).get(...params) : db.prepare(sql).get(params));
  const all = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).all(...params) : db.prepare(sql).all(params));
  const run = (sql, params = []) => (Array.isArray(params) ? db.prepare(sql).run(...params) : db.prepare(sql).run(params));
  let counter = 0;
  const nowIso = () => new Date(1750000000000 + ++counter * 1000).toISOString();
  const deps = { all, one, run, id: (prefix) => `${prefix}_${++counter}`, now: nowIso };

  run(
    `INSERT INTO capabilities (id, slug, name, created_at, updated_at)
     VALUES ('cap_ci', 'ci-pipeline', 'CI Pipeline', ?, ?)`,
    [nowIso(), nowIso()]
  );
  const insertRun = (runId, status) =>
    run(
      `INSERT INTO runs (id, capability_id, capability_slug, capability_name, workflow_version, status, created_at, updated_at)
       VALUES (?, 'cap_ci', 'ci-pipeline', 'CI Pipeline', 1, ?, ?, ?)`,
      [runId, status, nowIso(), nowIso()]
    );
  const setRunStatus = (runId, status) => run("UPDATE runs SET status = ? WHERE id = ?", [status, runId]);

  const scm = createScmStore(deps);
  const repo = scm.upsertScmRepo({ owner: "o", name: "r", fullName: "o/r" });
  return { db, ci: createCiStore(deps), scm, repo, insertRun, setRunStatus };
}

function pipelineInput(repo, runId, overrides = {}) {
  return {
    repoId: repo.id,
    runId,
    name: "ci",
    trigger: { provider: "github", event: "push", deliveryId: "d-1", headSha: "a".repeat(40) },
    configSource: { ref: "main", sha: "b".repeat(40), path: ".runyard/ci.yml" },
    tested: { strategy: "head", headSha: "a".repeat(40) },
    commitSha: "a".repeat(40),
    concurrencyKey: "o/r/push/main",
    jobs: [
      { jobName: "lint", needs: [], executor: "native", spec: { commands: ["pnpm lint"] } },
      { jobName: "test", needs: ["lint"], executor: "native", spec: { commands: ["pnpm test"] } }
    ],
    ...overrides
  };
}

describe("ci pipelines", () => {
  it("creates a pipeline with jobs and immutable provenance", () => {
    const { ci, repo, insertRun } = createHarness();
    insertRun("run_parent", "running");
    const pipeline = ci.createCiPipeline(pipelineInput(repo, "run_parent"));
    assert.equal(pipeline.runId, "run_parent");
    assert.equal(pipeline.trigger.deliveryId, "d-1");
    assert.equal(pipeline.configSource.sha, "b".repeat(40));
    const jobs = ci.listCiJobs(pipeline.id);
    assert.deepEqual(jobs.map((j) => j.jobName), ["lint", "test"]);
    assert.deepEqual(jobs[1].needs, ["lint"]);
    assert.equal(jobs.every((j) => j.phase === "pending"), true);
    assert.equal(ci.getCiPipelineByRunId("run_parent").id, pipeline.id);
  });

  it("lists active pipelines by live parent-run status and concurrency key", () => {
    const { ci, repo, insertRun, setRunStatus } = createHarness();
    insertRun("run_a", "running");
    insertRun("run_b", "running");
    const a = ci.createCiPipeline(pipelineInput(repo, "run_a"));
    const b = ci.createCiPipeline(pipelineInput(repo, "run_b", { trigger: { deliveryId: "d-2" } }));
    assert.deepEqual(ci.listActiveCiPipelines().map((p) => p.id), [a.id, b.id]);
    assert.equal(ci.listActiveCiPipelines({ concurrencyKey: "o/r/push/main" }).length, 2);

    setRunStatus("run_a", "succeeded");
    assert.deepEqual(ci.listActiveCiPipelines().map((p) => p.id), [b.id]);

    const superseded = ci.markCiPipelineSuperseded(a.id, b.id);
    assert.equal(superseded.supersededBy, b.id);
  });
});

describe("ci jobs", () => {
  it("dispatch is guarded: only a pending job takes a run id, exactly once", () => {
    const { ci, repo, insertRun } = createHarness();
    insertRun("run_parent", "running");
    const pipeline = ci.createCiPipeline(pipelineInput(repo, "run_parent"));
    const [lint] = ci.listCiJobs(pipeline.id);

    insertRun("run_lint", "queued");
    const dispatched = ci.markCiJobDispatched(lint.id, "run_lint");
    assert.equal(dispatched.phase, "dispatched");
    assert.equal(dispatched.runId, "run_lint");
    // Replay (restart recovery) is a no-op, not a double dispatch.
    assert.equal(ci.markCiJobDispatched(lint.id, "run_other"), null);
    assert.equal(ci.getCiJobByRunId("run_lint").id, lint.id);
  });

  it("skip/cancel only applies to pending jobs and records a reason", () => {
    const { ci, repo, insertRun } = createHarness();
    insertRun("run_parent", "running");
    const pipeline = ci.createCiPipeline(pipelineInput(repo, "run_parent"));
    const [lint, test] = ci.listCiJobs(pipeline.id);

    const skipped = ci.markCiJobPhase(test.id, "skipped", "needs lint failed");
    assert.equal(skipped.phase, "skipped");
    assert.equal(skipped.phaseReason, "needs lint failed");

    insertRun("run_lint", "queued");
    ci.markCiJobDispatched(lint.id, "run_lint");
    assert.equal(ci.markCiJobPhase(lint.id, "cancelled", "late"), null, "dispatched jobs are owned by their run");
  });

  it("tracks the checks-reporter ledger per job", () => {
    const { ci, repo, insertRun } = createHarness();
    insertRun("run_parent", "running");
    const pipeline = ci.createCiPipeline(pipelineInput(repo, "run_parent"));
    const [lint] = ci.listCiJobs(pipeline.id);

    const updated = ci.updateCiJobCheck(lint.id, { checkRunId: "987", checkState: "queued", checkAttempts: 1 });
    assert.equal(updated.checkRunId, "987");
    assert.equal(updated.checkState, "queued");
    const failed = ci.updateCiJobCheck(lint.id, { checkAttempts: 2, lastCheckError: "rate limited" });
    assert.equal(failed.checkRunId, "987");
    assert.equal(failed.lastCheckError, "rate limited");
  });
});
