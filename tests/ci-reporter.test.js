import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCiHarness, SAMPLE_CI_YML, pushTrigger } from "./ci-harness.js";
import {
  annotationsFromText,
  checkConclusionFor,
  desiredJobCheck,
  MAX_ANNOTATIONS,
  MAX_CHECK_SYNC_ATTEMPTS
} from "../src/ciReporter.js";

const CONFIG_KEY = `yolo-maxi/runyard@${"a".repeat(40)}`;

async function pipelineHarness(files = { [CONFIG_KEY]: SAMPLE_CI_YML }) {
  const h = createCiHarness({ githubFiles: files });
  h.connectRepo({ trustPolicy: { level: "trusted" } });
  const outcome = await h.ciTriggers.createPipelineForTrigger(pushTrigger());
  return { h, outcome };
}

describe("conclusion mapping", () => {
  it("maps every run outcome to the documented GitHub conclusion", () => {
    assert.equal(checkConclusionFor("succeeded"), "success");
    assert.equal(checkConclusionFor("failed"), "failure");
    assert.equal(checkConclusionFor("cancelled"), "cancelled");
    assert.equal(checkConclusionFor("timed_out"), "timed_out");
    assert.equal(checkConclusionFor("skipped"), "skipped");
    assert.equal(checkConclusionFor("skipped", "policy: native denied"), "action_required");
    assert.equal(checkConclusionFor("infra_unavailable"), "action_required");
    assert.equal(checkConclusionFor("blocked_by_preflight"), "action_required");
    assert.equal(checkConclusionFor("invalid_output"), "failure");
  });

  it("extracts bounded file:line annotations and rejects unsafe paths", () => {
    const text = [
      "src/db.js:42: unexpected token",
      "tests/x.test.js:7:3 assertion failed",
      "/etc/passwd:1: nope",
      "../up.js:2: nope",
      "no annotation here",
      ...Array.from({ length: 30 }, (_, i) => `src/gen${i}.js:${i + 1}: overflow`)
    ].join("\n");
    const annotations = annotationsFromText(text);
    assert.equal(annotations.length, MAX_ANNOTATIONS);
    assert.deepEqual(annotations[0], {
      path: "src/db.js",
      start_line: 42,
      end_line: 42,
      annotation_level: "failure",
      message: "unexpected token"
    });
    assert.ok(!annotations.some((a) => a.path.startsWith("/") || a.path.includes("..")));
  });
});

describe("desired job checks", () => {
  it("carries external id, details deep link, and head sha through every state", async () => {
    const { h, outcome } = await pipelineHarness();
    const pipeline = h.ci.getCiPipeline(outcome.pipelineId);
    const job = h.ci.listCiJobs(pipeline.id)[0];
    const pending = desiredJobCheck({ job, run: null, pipeline, baseUrl: "http://hub.test" });
    assert.equal(pending.fingerprint, "queued");
    assert.equal(pending.payload.name, "runyard/lint");
    assert.equal(pending.payload.external_id, job.id);
    assert.equal(pending.payload.head_sha, "a".repeat(40));

    h.orchestrator.advancePipeline(pipeline.id);
    const dispatched = h.ci.listCiJobs(pipeline.id)[0];
    const run = h.getRun(dispatched.runId);
    const queued = desiredJobCheck({ job: dispatched, run, pipeline, baseUrl: "http://hub.test" });
    assert.equal(queued.fingerprint, "queued");
    assert.equal(queued.payload.details_url, `http://hub.test/app#runs/${run.id}`);

    h.finishJobRun(run.id, "failed", { error: "src/db.js:42: boom" });
    const failed = desiredJobCheck({ job: dispatched, run: h.getRun(run.id), pipeline, baseUrl: "http://hub.test" });
    assert.equal(failed.fingerprint, "completed:failure");
    assert.equal(failed.payload.output.annotations.length, 1);
  });
});

describe("reporter sync", () => {
  it("creates checks once, updates on state change, and is idempotent", async () => {
    const { h, outcome } = await pipelineHarness();
    h.orchestrator.advancePipeline(outcome.pipelineId);
    let result = await h.reporter.sync();
    assert.equal(result.synced, 3, "one check per job");
    assert.equal(h.checkCalls.filter((c) => c.op === "create").length, 3);

    // Nothing changed -> no API calls.
    result = await h.reporter.sync();
    assert.equal(result.synced, 0);
    assert.equal(h.checkCalls.length, 3);

    const lint = h.ci.listCiJobs(outcome.pipelineId).find((j) => j.jobName === "lint");
    h.finishJobRun(lint.runId, "succeeded");
    await h.reporter.sync();
    const updates = h.checkCalls.filter((c) => c.op === "update");
    assert.ok(updates.some((c) => c.payload.conclusion === "success" && c.payload.name === "runyard/lint"));
    const refreshed = h.ci.getCiJob(lint.id);
    assert.equal(refreshed.checkState, "completed:success");
    assert.ok(refreshed.checkRunId);
  });

  it("publishes a pipeline-level failure check for invalid config", async () => {
    const { h, outcome } = await pipelineHarness({ [CONFIG_KEY]: "version: 1\njobs: {}\n" });
    assert.equal(outcome.outcome, "config_invalid");
    const result = await h.reporter.sync();
    assert.equal(result.synced, 1);
    const call = h.checkCalls[0];
    assert.equal(call.payload.name, "runyard/ci");
    assert.equal(call.payload.conclusion, "failure");
    assert.match(call.payload.output.summary, /jobs must define at least one job/);
  });

  it("records reporter outages in the ledger and retries up to the cap without touching runs", async () => {
    const { h, outcome } = await pipelineHarness();
    h.orchestrator.advancePipeline(outcome.pipelineId);
    const lint = h.ci.listCiJobs(outcome.pipelineId).find((j) => j.jobName === "lint");

    h.githubApp.createCheckRun = async () => {
      throw new Error("GitHub down");
    };
    for (let i = 0; i < MAX_CHECK_SYNC_ATTEMPTS + 3; i++) {
      await h.reporter.sync();
    }
    const job = h.ci.getCiJob(lint.id);
    assert.equal(job.checkAttempts, MAX_CHECK_SYNC_ATTEMPTS, "retries capped");
    assert.match(job.lastCheckError, /GitHub down/);
    assert.equal(h.getRun(lint.runId).status, "queued", "reporter outage never disturbs the run");

    // Operator reconciliation resets the counters and heals once GitHub is back.
    let id = 900;
    h.githubApp.createCheckRun = async () => ({ id: ++id });
    const healed = await h.reporter.resyncPipeline(outcome.pipelineId);
    assert.ok(healed.synced >= 1);
    assert.equal(h.ci.getCiJob(lint.id).checkState, "queued");
    assert.equal(h.ci.getCiJob(lint.id).lastCheckError, "");
  });

  it("does nothing when the GitHub App is unconfigured", async () => {
    const { h, outcome } = await pipelineHarness();
    h.orchestrator.advancePipeline(outcome.pipelineId);
    h.githubApp.configured = () => false;
    const result = await h.reporter.sync();
    assert.equal(result.skipped, "unconfigured");
    assert.equal(h.checkCalls.length, 0);
  });
});

describe("review regressions (reporter)", () => {
  it("resets the retry budget when the desired check state changes", async () => {
    const { h, outcome } = await pipelineHarness();
    h.orchestrator.advancePipeline(outcome.pipelineId);
    const lint = h.ci.listCiJobs(outcome.pipelineId).find((j) => j.jobName === "lint");

    // Exhaust the budget while the desired state is 'queued'.
    const realCreate = h.githubApp.createCheckRun;
    h.githubApp.createCheckRun = async () => {
      throw new Error("GitHub down");
    };
    for (let i = 0; i < MAX_CHECK_SYNC_ATTEMPTS + 2; i++) await h.reporter.sync();
    assert.equal(h.ci.getCiJob(lint.id).checkAttempts, MAX_CHECK_SYNC_ATTEMPTS);

    // GitHub recovers AND the job concludes: the terminal state must report
    // WITHOUT any operator resync — the budget was spent on 'queued'.
    h.githubApp.createCheckRun = realCreate;
    h.finishJobRun(lint.runId, "succeeded");
    await h.reporter.sync();
    assert.equal(h.ci.getCiJob(lint.id).checkState, "completed:success");
  });

  it("still syncs pipelines older than the recency window while their run is active", async () => {
    const { h, outcome } = await pipelineHarness();
    h.orchestrator.advancePipeline(outcome.pipelineId);
    // 25h pass with the pipeline still running (long jobs / runner offline).
    h.clock.advance(25 * 60 * 60_000);
    const result = await h.reporter.sync();
    assert.ok(result.synced >= 1, "active-but-old pipeline still reaches the Checks API");

    // And its conclusion later re-touches the row, so the FINAL state syncs too.
    const lint = h.ci.listCiJobs(outcome.pipelineId).find((j) => j.jobName === "lint");
    h.finishJobRun(lint.runId, "failed", { error: "late failure" });
    await h.reporter.sync();
    assert.equal(h.ci.getCiJob(lint.id).checkState, "completed:failure");
  });
});
