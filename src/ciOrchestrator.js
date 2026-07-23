import { RUN_TERMINAL } from "./runLifecyclePolicy.js";
import { CI_JOB_CAPABILITY_SLUG, isCiJobRun, isCiPipelineRun } from "./ciCapabilities.js";
import { deepLinks } from "./deepLinks.js";

// CI orchestrator: advances pipeline DAGs on canonical runs. Deterministic
// and idempotent — every action is guarded by durable state (job phase,
// existing child runs, run transition decisions), so hub restarts and
// concurrent nudges (webhook, run-status observer, 60s sweep) never replay a
// completed side effect. No LLM anywhere in this path.

// Keep-alive margin: the stall reaper fails runs quiet for runStallMs
// (default 15m); a healthy-but-quiet pipeline parent gets a progress event
// well before that.
const KEEPALIVE_AFTER_MS = 8 * 60_000;

// How a job stands, folding phase and (when dispatched) the live run status.
export function ciJobStanding(job, run) {
  if (job.phase === "skipped") return { state: "skipped", terminal: true, ok: false };
  if (job.phase === "cancelled") return { state: "cancelled", terminal: true, ok: false };
  if (job.phase === "pending") return { state: "pending", terminal: false, ok: false };
  const status = run?.status || "";
  if (status === "succeeded") return { state: "succeeded", terminal: true, ok: true };
  if (RUN_TERMINAL.has(status)) return { state: status, terminal: true, ok: false };
  return { state: status || "dispatched", terminal: false, ok: false };
}

// Parent-run conclusion once every job is settled. Distinguishes code/test
// failure from CI infrastructure failure.
export function ciPipelineConclusion(standings) {
  const failed = standings.filter((s) => s.required && s.terminal && !s.ok && s.state !== "skipped");
  if (!failed.length) return { status: "succeeded", summary: "all required jobs succeeded" };
  if (failed.every((s) => s.state === "cancelled")) return { status: "cancelled", summary: "required jobs were cancelled" };
  if (failed.every((s) => ["infra_unavailable", "blocked_by_preflight"].includes(s.state))) {
    return {
      status: "infra_unavailable",
      summary: `CI infrastructure failure: ${failed.map((s) => `${s.jobName} ${s.state}`).join(", ")}`
    };
  }
  if (failed.every((s) => s.state === "timed_out")) {
    return { status: "timed_out", summary: `required jobs timed out: ${failed.map((s) => s.jobName).join(", ")}` };
  }
  return { status: "failed", summary: `required jobs failed: ${failed.map((s) => `${s.jobName} (${s.state})`).join(", ")}` };
}

export function createCiOrchestrator({
  env,
  getCiPipeline,
  listCiJobs,
  listActiveCiPipelines,
  markCiJobDispatched,
  markCiJobPhase,
  findCiJobRunCandidate,
  lastCiRunEventAt,
  getCiJobByRunId,
  getScmRepo,
  getCapability,
  createRun,
  transitionRun,
  addRunEvent,
  getRun,
  pruneScmWebhookDeliveries,
  nowIso = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  logError = console.error
} = {}) {
  function jobRunInput(pipeline, repo, job) {
    return {
      __ci: {
        role: "job",
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        jobId: job.id,
        jobName: job.jobName,
        repo: {
          provider: repo.provider,
          fullName: repo.fullName,
          cloneUrl: repo.cloneUrl,
          defaultBranch: repo.defaultBranch
        },
        checkout: pipeline.tested,
        executor: job.executor,
        spec: job.spec,
        untrusted: Boolean(pipeline.trigger?.untrusted),
        // Repo-policy runner allowlist, enforced hub-side at claim time
        // (runnerMatchesAssignment) on top of the capability's `ci` tag.
        ...(repo?.trustPolicy?.runnerTags?.length ? { requiredRunnerTags: repo.trustPolicy.runnerTags } : {})
      },
      // Existing hub secret channel: names only; values are decrypted at
      // claim time. Untrusted contexts were stripped at compile.
      ...(job.spec.secrets?.length ? { secretNames: job.spec.secrets } : {})
    };
  }

  function dispatchJob(pipeline, repo, parentRun, job) {
    const capability = getCapability(CI_JOB_CAPABILITY_SLUG);
    if (!capability) throw new Error("ci-job capability is not seeded");
    // Restart recovery: adopt a child run created by a crashed dispatch.
    let childRun = findCiJobRunCandidate(parentRun.id, job.id);
    if (!childRun) {
      childRun = createRun(capability, jobRunInput(pipeline, repo, job), {
        parentRunId: parentRun.id,
        requestedBy: "system:ci-orchestrator",
        origin: { type: "ci", pipelineId: pipeline.id, jobName: job.jobName, repo: repo.fullName }
      });
    }
    const marked = markCiJobDispatched(job.id, childRun.id);
    if (!marked) {
      // Lost a race with another dispatcher: if OUR fresh run is the orphan,
      // cancel it so exactly one child run survives per job.
      const current = findCiJobRunCandidate(parentRun.id, job.id);
      if (current && current.id !== childRun.id) transitionRun(childRun.id, "cancelled", { completed_at: nowIso() });
      return null;
    }
    addRunEvent(parentRun.id, "ci.job.dispatched", `Dispatched job ${job.jobName} as run ${childRun.id}`, {
      "cicd.pipeline.name": pipeline.name,
      "cicd.pipeline.run.id": pipeline.id,
      "cicd.pipeline.task.name": job.jobName,
      "cicd.pipeline.task.run.id": childRun.id,
      executor: job.executor,
      deepLink: deepLinks.run(childRun.id)
    });
    return childRun;
  }

  function cancelPipelineJobs(pipeline, jobs, reason) {
    for (const job of jobs) {
      if (job.phase === "pending") {
        markCiJobPhase(job.id, "cancelled", reason);
        continue;
      }
      if (job.phase !== "dispatched" || !job.runId) continue;
      const run = getRun(job.runId);
      if (run && !RUN_TERMINAL.has(run.status)) {
        // The runner observes the hub-terminal status on its poll loop and
        // kills the job process group; no push channel needed.
        transitionRun(job.runId, "cancelled", { current_step: "cancelled", completed_at: nowIso() });
      }
    }
  }

  // Advance one pipeline: cancel-propagate, skip broken dependents, dispatch
  // ready jobs, reconcile the parent, keep the reaper informed. Safe to call
  // from any number of triggers concurrently.
  function advancePipeline(pipelineId) {
    const pipeline = getCiPipeline(pipelineId);
    if (!pipeline?.runId) return null;
    const parentRun = getRun(pipeline.runId);
    if (!parentRun) return null;
    const repo = getScmRepo(pipeline.repoId);
    const jobs = listCiJobs(pipeline.id);

    if (RUN_TERMINAL.has(parentRun.status)) {
      // Parent ended (operator cancel, supersede, config failure): make sure
      // no child keeps running and nothing new dispatches.
      cancelPipelineJobs(pipeline, jobs, `pipeline ${parentRun.status}`);
      return { settled: true, status: parentRun.status };
    }

    const standings = jobs.map((job) => ({
      jobName: job.jobName,
      required: job.required,
      ...ciJobStanding(job, job.runId ? getRun(job.runId) : null)
    }));
    const byName = new Map(jobs.map((job, index) => [job.jobName, { job, standing: standings[index] }]));

    for (const { job, standing } of byName.values()) {
      if (standing.state !== "pending") continue;
      const needs = job.needs.map((name) => byName.get(name)).filter(Boolean);
      const failedNeed = needs.find(({ standing: s }) => s.terminal && !s.ok);
      if (failedNeed) {
        const marked = markCiJobPhase(job.id, "skipped", `dependency ${failedNeed.job.jobName} ${failedNeed.standing.state}`);
        if (marked) {
          standing.state = "skipped";
          standing.terminal = true;
          addRunEvent(parentRun.id, "ci.job.skipped", `Skipped job ${job.jobName}: dependency ${failedNeed.job.jobName} ${failedNeed.standing.state}`, {
            "cicd.pipeline.task.name": job.jobName,
            reason: `dependency ${failedNeed.job.jobName} ${failedNeed.standing.state}`
          });
        }
        continue;
      }
      if (needs.every(({ standing: s }) => s.ok)) {
        try {
          const childRun = dispatchJob(pipeline, repo, parentRun, job);
          if (childRun) {
            standing.state = "dispatched";
          }
        } catch (error) {
          logError(`CI dispatch failed for ${pipeline.id}/${job.jobName}:`, error.message);
        }
      }
    }

    // Re-read standings for settlement (phases may have moved above).
    const settledStandings = listCiJobs(pipeline.id).map((job) => ({
      jobName: job.jobName,
      required: job.required,
      state: undefined,
      ...ciJobStanding(job, job.runId ? getRun(job.runId) : null)
    }));
    const allSettled = settledStandings.length > 0 && settledStandings.every((s) => s.terminal);
    if (allSettled) {
      const conclusion = ciPipelineConclusion(settledStandings);
      const result = transitionRun(parentRun.id, conclusion.status, {
        current_step: conclusion.status === "succeeded" ? "completed" : conclusion.status,
        ...(conclusion.status === "succeeded"
          ? { output: { conclusion: conclusion.status, summary: conclusion.summary, jobs: settledStandings } }
          : { error: conclusion.summary }),
        completed_at: nowIso()
      });
      if (result.ok && !result.idempotent) {
        addRunEvent(parentRun.id, `ci.pipeline.${conclusion.status === "succeeded" ? "succeeded" : "failed"}`, conclusion.summary, {
          "cicd.pipeline.name": pipeline.name,
          "cicd.pipeline.run.id": pipeline.id,
          "cicd.pipeline.result": conclusion.status,
          jobs: settledStandings.map((s) => ({ job: s.jobName, state: s.state, required: s.required }))
        });
      }
      return { settled: true, status: conclusion.status };
    }

    // Keep-alive: a healthy pipeline whose jobs are quietly running must not
    // be stall-reaped. Only emitted when the parent's event stream has been
    // quiet for a while, so run_events stays bounded.
    const lastEventAt = lastCiRunEventAt(parentRun.id);
    if (lastEventAt && nowMs() - Date.parse(lastEventAt) > KEEPALIVE_AFTER_MS) {
      const active = settledStandings.filter((s) => !s.terminal).map((s) => `${s.jobName}:${s.state}`);
      addRunEvent(parentRun.id, "ci.pipeline.progress", `Pipeline in progress (${active.join(", ") || "settling"})`, {
        "cicd.pipeline.run.id": pipeline.id
      });
    }
    return { settled: false };
  }

  // Fast path invoked from the run-status observer: a CI child run changed
  // status -> advance its pipeline immediately (the 60s sweep is the backstop).
  function handleRunStatusChange(run) {
    try {
      if (isCiJobRun(run)) {
        const job = getCiJobByRunId(run.id);
        if (job) advancePipeline(job.pipelineId);
        return;
      }
      if (isCiPipelineRun(run) && RUN_TERMINAL.has(run.status)) {
        const pipelineId = run.input?.__ci?.pipelineId;
        if (pipelineId) advancePipeline(pipelineId);
      }
    } catch (error) {
      logError("CI run-status advance failed:", error.message);
    }
  }

  // Periodic sweep: advance every active pipeline (restart recovery + the
  // event-driven fast path's backstop) and apply delivery-ledger retention.
  function sweep() {
    const advanced = [];
    for (const pipeline of listActiveCiPipelines()) {
      try {
        advancePipeline(pipeline.id);
        advanced.push(pipeline.id);
      } catch (error) {
        logError(`CI sweep failed for pipeline ${pipeline.id}:`, error.message);
      }
    }
    try {
      const cutoff = new Date(nowMs() - env.ciDeliveryRetentionMs).toISOString();
      pruneScmWebhookDeliveries(cutoff);
    } catch (error) {
      logError("CI delivery prune failed:", error.message);
    }
    return advanced;
  }

  return { advancePipeline, handleRunStatusChange, sweep };
}
