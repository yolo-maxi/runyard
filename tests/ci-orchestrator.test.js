import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCiHarness, SAMPLE_CI_YML, pushTrigger, prTrigger } from "./ci-harness.js";
import { compileCiJobs, triggerTrustContext, ciTestedFromTrigger } from "../src/ciTriggers.js";
import { ciJobStanding, ciPipelineConclusion } from "../src/ciOrchestrator.js";
import { parseCiConfig } from "../src/ciConfig.js";

const CONFIG_KEY = `yolo-maxi/runyard@${"a".repeat(40)}`;
const PR_CONFIG_KEY = `yolo-maxi/runyard@${"b".repeat(40)}`;

function harnessWithConfig(extraFiles = {}) {
  return createCiHarness({
    githubFiles: {
      [CONFIG_KEY]: SAMPLE_CI_YML,
      [PR_CONFIG_KEY]: SAMPLE_CI_YML,
      ...extraFiles
    }
  });
}

describe("trust context + job compilation", () => {
  const { config } = parseCiConfig(SAMPLE_CI_YML);

  it("fork PRs are always untrusted; same-repo PRs follow repo trust", () => {
    const repoTrusted = { trustPolicy: { level: "trusted", allowNative: true, runnerTags: [] } };
    const fork = triggerTrustContext(prTrigger({ headRepoFullName: "attacker/runyard" }), repoTrusted);
    assert.deepEqual(fork, { fork: true, untrusted: true });
    const sameRepo = triggerTrustContext(prTrigger(), repoTrusted);
    assert.deepEqual(sameRepo, { fork: false, untrusted: false });
    const untrustedRepo = triggerTrustContext(prTrigger(), { trustPolicy: { level: "untrusted" } });
    assert.equal(untrustedRepo.untrusted, true);
  });

  it("untrusted contexts lose secrets and native execution", () => {
    const jobs = compileCiJobs(config, { untrusted: true });
    const test = jobs.find((j) => j.jobName === "test");
    assert.deepEqual(test.spec.secrets, []);
    assert.match(test.spec.secretsDenied, /untrusted/);
    assert.match(test.policyDenied, /^policy: native/);
    const trusted = compileCiJobs(config, { untrusted: false });
    assert.deepEqual(trusted.find((j) => j.jobName === "test").spec.secrets, ["NPM_TOKEN"]);
    assert.equal(trusted.find((j) => j.jobName === "test").policyDenied, undefined);
  });

  it("PRs test the deterministic merge candidate; pushes test the head", () => {
    assert.equal(ciTestedFromTrigger(prTrigger()).strategy, "merge");
    assert.equal(ciTestedFromTrigger(pushTrigger()).strategy, "head");
  });
});

describe("pipeline creation from triggers", () => {
  it("creates a running parent run with pending jobs from a push", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const outcome = await h.ciTriggers.createPipelineForTrigger(pushTrigger());
    assert.equal(outcome.status, "accepted");
    const pipeline = h.ci.getCiPipeline(outcome.pipelineId);
    assert.equal(pipeline.runId, outcome.runId);
    assert.equal(pipeline.configSource.sha, "a".repeat(40));
    const parent = h.getRun(outcome.runId);
    assert.equal(parent.status, "running");
    assert.equal(parent.capabilitySlug, "ci-pipeline");
    assert.deepEqual(h.ci.listCiJobs(pipeline.id).map((j) => j.phase), ["pending", "pending", "pending"]);
  });

  it("ignores disabled repos, unknown repos, deleted refs, and non-matching triggers", async () => {
    const h = harnessWithConfig();
    const repo = h.connectRepo();
    assert.equal((await h.ciTriggers.createPipelineForTrigger(pushTrigger({ repoFullName: "o/unknown" }))).status, "invalid");
    assert.equal((await h.ciTriggers.createPipelineForTrigger(pushTrigger({ deleted: true }))).status, "ignored");
    assert.equal((await h.ciTriggers.createPipelineForTrigger(pushTrigger({ ref: "refs/heads/side" }))).status, "ignored");
    h.scm.setScmRepoEnabled(repo.id, false);
    assert.equal((await h.ciTriggers.createPipelineForTrigger(pushTrigger())).status, "ignored");
  });

  it("invalid config becomes a blocked pipeline with evidence, not a silent drop", async () => {
    const h = createCiHarness({ githubFiles: { [CONFIG_KEY]: "version: 1\njobs: {}\n" } });
    h.connectRepo();
    const outcome = await h.ciTriggers.createPipelineForTrigger(pushTrigger());
    assert.equal(outcome.outcome, "config_invalid");
    const parent = h.getRun(outcome.runId);
    assert.equal(parent.status, "blocked_by_preflight");
    assert.match(parent.error, /CI config invalid/);
    const pipeline = h.ci.getCiPipeline(outcome.pipelineId);
    assert.ok(pipeline.configSource.errors.length >= 1);
    assert.equal(h.ci.listCiJobs(pipeline.id).length, 0);
  });

  it("missing config at the trusted revision is a normal ignore", async () => {
    const h = createCiHarness({ githubFiles: {} });
    h.connectRepo();
    const outcome = await h.ciTriggers.createPipelineForTrigger(pushTrigger());
    assert.equal(outcome.status, "ignored");
    assert.match(outcome.reason, /no \.runyard\/ci\.yml/);
  });

  it("PR pipelines load config from the trusted BASE sha, never the head", async () => {
    const h = createCiHarness({
      githubFiles: { [PR_CONFIG_KEY]: SAMPLE_CI_YML, [`yolo-maxi/runyard@${"c".repeat(40)}`]: "version: 1\njobs: {}" }
    });
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const outcome = await h.ciTriggers.createPipelineForTrigger(prTrigger());
    assert.equal(outcome.status, "accepted");
    const pipeline = h.ci.getCiPipeline(outcome.pipelineId);
    assert.equal(pipeline.configSource.sha, "b".repeat(40), "config pinned to base sha");
    assert.equal(pipeline.tested.strategy, "merge");
  });

  it("fork PR pipelines policy-skip native jobs at compile", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const outcome = await h.ciTriggers.createPipelineForTrigger(
      prTrigger({ headRepoFullName: "attacker/runyard" })
    );
    const jobs = h.ci.listCiJobs(outcome.pipelineId);
    assert.equal(jobs.every((j) => j.phase === "skipped"), true, "all-native config fully policy-skipped for forks");
    assert.match(jobs[0].phaseReason, /^policy: native/);
  });
});

describe("DAG orchestration", () => {
  async function acceptedPipeline(h) {
    const outcome = await h.ciTriggers.createPipelineForTrigger(pushTrigger());
    assert.equal(outcome.status, "accepted");
    return outcome;
  }

  it("dispatches only ready jobs, advances on completion, reconciles success", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const { pipelineId, runId } = await acceptedPipeline(h);

    h.orchestrator.advancePipeline(pipelineId);
    let jobs = h.ci.listCiJobs(pipelineId);
    const lint = jobs.find((j) => j.jobName === "lint");
    assert.equal(lint.phase, "dispatched");
    assert.equal(jobs.filter((j) => j.phase === "dispatched").length, 1, "needs-gated jobs wait");
    const lintRun = h.getRun(lint.runId);
    assert.equal(lintRun.status, "queued");
    assert.equal(lintRun.input.__ci.jobName, "lint");
    assert.deepEqual(lintRun.input.secretNames, undefined);

    // Runner finishes lint -> observer advances -> test + docs dispatch.
    h.finishJobRun(lint.runId, "succeeded");
    jobs = h.ci.listCiJobs(pipelineId);
    const test = jobs.find((j) => j.jobName === "test");
    const docs = jobs.find((j) => j.jobName === "docs");
    assert.equal(test.phase, "dispatched");
    assert.equal(docs.phase, "dispatched");
    assert.deepEqual(h.getRun(test.runId).input.secretNames, ["NPM_TOKEN"]);

    h.finishJobRun(test.runId, "succeeded");
    h.finishJobRun(docs.runId, "succeeded");
    const parent = h.getRun(runId);
    assert.equal(parent.status, "succeeded");
    assert.equal(parent.output.conclusion, "succeeded");
  });

  it("failure of a required job skips dependents and fails the parent; optional failures don't", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const { pipelineId, runId } = await acceptedPipeline(h);
    h.orchestrator.advancePipeline(pipelineId);
    const lint = h.ci.listCiJobs(pipelineId).find((j) => j.jobName === "lint");
    h.finishJobRun(lint.runId, "failed", { error: "lint broke" });

    const jobs = h.ci.listCiJobs(pipelineId);
    assert.equal(jobs.find((j) => j.jobName === "test").phase, "skipped");
    assert.match(jobs.find((j) => j.jobName === "test").phaseReason, /dependency lint failed/);
    const parent = h.getRun(runId);
    assert.equal(parent.status, "failed");
    assert.match(parent.error, /lint \(failed\)/);
  });

  it("optional-job failure still succeeds the pipeline", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const { pipelineId, runId } = await acceptedPipeline(h);
    h.orchestrator.advancePipeline(pipelineId);
    const lint = h.ci.listCiJobs(pipelineId).find((j) => j.jobName === "lint");
    h.finishJobRun(lint.runId, "succeeded");
    const jobs = h.ci.listCiJobs(pipelineId);
    h.finishJobRun(jobs.find((j) => j.jobName === "test").runId, "succeeded");
    h.finishJobRun(jobs.find((j) => j.jobName === "docs").runId, "failed", { error: "docs flake" });
    assert.equal(h.getRun(runId).status, "succeeded");
  });

  it("advance is idempotent: repeated calls never duplicate job runs", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const { pipelineId } = await acceptedPipeline(h);
    h.orchestrator.advancePipeline(pipelineId);
    h.orchestrator.advancePipeline(pipelineId);
    h.orchestrator.sweep();
    const jobRuns = h.listRuns({ limit: 100, includeInternal: true }).filter((r) => r.capabilitySlug === "ci-job");
    assert.equal(jobRuns.length, 1, "exactly one lint run despite three advances");
  });

  it("cancelling the parent cancels dispatched runs and pending jobs", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const { pipelineId, runId } = await acceptedPipeline(h);
    h.orchestrator.advancePipeline(pipelineId);
    h.transitionRun(runId, "cancelled", {});
    const jobs = h.ci.listCiJobs(pipelineId);
    const lint = jobs.find((j) => j.jobName === "lint");
    assert.equal(h.getRun(lint.runId).status, "cancelled");
    assert.equal(jobs.find((j) => j.jobName === "test").phase, "cancelled");
  });

  it("a newer pipeline on the same concurrency key cancel-supersedes the older", async () => {
    const h = harnessWithConfig({ [`yolo-maxi/runyard@${"d".repeat(40)}`]: SAMPLE_CI_YML });
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const first = await h.ciTriggers.createPipelineForTrigger(pushTrigger({ deliveryId: "del-1" }));
    h.orchestrator.advancePipeline(first.pipelineId);
    const second = await h.ciTriggers.createPipelineForTrigger(
      pushTrigger({ deliveryId: "del-2", headSha: "d".repeat(40) })
    );
    assert.deepEqual(second.supersededPipelineIds, [first.pipelineId]);
    assert.equal(h.getRun(first.runId).status, "cancelled");
    assert.equal(h.ci.getCiPipeline(first.pipelineId).supersededBy, second.pipelineId);
    assert.equal(h.getRun(second.runId).status, "running");
  });

  it("emits a keep-alive progress event when the parent goes quiet", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const { pipelineId } = await acceptedPipeline(h);
    h.orchestrator.advancePipeline(pipelineId);
    h.clock.advance(9 * 60_000);
    h.orchestrator.sweep();
    assert.ok(h.events.some((e) => e.type === "ci.pipeline.progress"), "quiet pipeline got a keep-alive event");
  });

  it("rerun creates a fresh pipeline with provenance to the original", async () => {
    const h = harnessWithConfig();
    h.connectRepo({ trustPolicy: { level: "trusted" } });
    const first = await acceptedPipeline(h);
    const rerun = await h.ciTriggers.rerunPipeline(first.pipelineId, { requestedBy: "operator" });
    assert.equal(rerun.status, "accepted");
    assert.notEqual(rerun.pipelineId, first.pipelineId);
    const pipeline = h.ci.getCiPipeline(rerun.pipelineId);
    assert.equal(pipeline.trigger.rerunOfPipelineId, first.pipelineId);
    // The rerun shares the concurrency key -> the original was superseded.
    assert.equal(h.getRun(first.runId).status, "cancelled");
  });
});

describe("standings + conclusions", () => {
  it("folds phase and run status into one standing", () => {
    assert.equal(ciJobStanding({ phase: "pending" }, null).state, "pending");
    assert.equal(ciJobStanding({ phase: "skipped" }, null).terminal, true);
    assert.equal(ciJobStanding({ phase: "dispatched" }, { status: "running" }).terminal, false);
    assert.deepEqual(ciJobStanding({ phase: "dispatched" }, { status: "succeeded" }), {
      state: "succeeded",
      terminal: true,
      ok: true
    });
  });

  it("distinguishes code failure, infra failure, timeout, and cancellation", () => {
    const base = { required: true, terminal: true, ok: false };
    assert.equal(ciPipelineConclusion([{ ...base, jobName: "a", state: "failed" }]).status, "failed");
    assert.equal(ciPipelineConclusion([{ ...base, jobName: "a", state: "infra_unavailable" }]).status, "infra_unavailable");
    assert.equal(ciPipelineConclusion([{ ...base, jobName: "a", state: "timed_out" }]).status, "timed_out");
    assert.equal(ciPipelineConclusion([{ ...base, jobName: "a", state: "cancelled" }]).status, "cancelled");
    assert.equal(
      ciPipelineConclusion([
        { jobName: "a", required: true, terminal: true, ok: true, state: "succeeded" },
        { jobName: "b", required: false, terminal: true, ok: false, state: "failed" }
      ]).status,
      "succeeded"
    );
  });
});
