import { RUN_TERMINAL } from "./runLifecyclePolicy.js";

// GitHub Checks reporter. Computes the DESIRED check state for every job of
// recently-touched pipelines from durable hub state, and idempotently syncs
// mismatches (stored fingerprint vs desired) through the Checks API with
// bounded retries. Reporter outage never touches run execution — jobs keep
// running; the ledger records the lag and the sweep catches up.

export const MAX_CHECK_SYNC_ATTEMPTS = 10;
export const MAX_ANNOTATIONS = 10;
const SCAN_WINDOW_MS = 24 * 60 * 60_000;

// GitHub conclusion for a settled job/run. Infrastructure and policy issues
// map to action_required so they are distinguishable from code/test failure.
export function checkConclusionFor(standingState, phaseReason = "") {
  if (standingState === "succeeded") return "success";
  if (standingState === "cancelled") return "cancelled";
  if (standingState === "timed_out") return "timed_out";
  if (standingState === "skipped") {
    return phaseReason.startsWith("policy:") ? "action_required" : "skipped";
  }
  if (["infra_unavailable", "blocked_by_preflight", "needs_human", "provider_limited"].includes(standingState)) {
    return "action_required";
  }
  return "failure";
}

// Bounded annotations from an error/log tail: recognizes `path:line[:col]`
// prefixes (compiler/test-runner style). Never more than MAX_ANNOTATIONS.
export function annotationsFromText(text = "") {
  const annotations = [];
  for (const line of String(text).split("\n")) {
    const match = /^\s*([\w./-]+\.[A-Za-z]{1,8}):(\d+)(?::(\d+))?[:\s]\s*(.{1,200})/.exec(line);
    if (!match) continue;
    const file = match[1];
    if (file.startsWith("/") || file.includes("..")) continue;
    annotations.push({
      path: file,
      start_line: Number(match[2]),
      end_line: Number(match[2]),
      annotation_level: "failure",
      message: match[4].trim()
    });
    if (annotations.length >= MAX_ANNOTATIONS) break;
  }
  return annotations;
}

// Desired check payload for one job. `fingerprint` is the idempotency key
// stored in ci_jobs.check_state.
export function desiredJobCheck({ job, run, pipeline, baseUrl }) {
  const name = `runyard/${job.jobName}`;
  const detailsUrl = run ? `${baseUrl}/app#runs/${run.id}` : `${baseUrl}/app#repositories`;
  const externalId = job.id;

  if (job.phase === "pending") {
    return { fingerprint: "queued", payload: { name, head_sha: pipeline.commitSha, external_id: externalId, details_url: detailsUrl, status: "queued" } };
  }
  if (job.phase === "skipped" || job.phase === "cancelled") {
    const conclusion = checkConclusionFor(job.phase === "cancelled" ? "cancelled" : "skipped", job.phaseReason);
    return {
      fingerprint: `completed:${conclusion}`,
      payload: {
        name,
        head_sha: pipeline.commitSha,
        external_id: externalId,
        details_url: detailsUrl,
        status: "completed",
        conclusion,
        output: { title: titleFor(conclusion), summary: (job.phaseReason || job.phase).slice(0, 1000) }
      }
    };
  }
  // dispatched: fold the live run status.
  const status = run?.status || "";
  if (!RUN_TERMINAL.has(status)) {
    const ghStatus = status === "running" || status === "paused" ? "in_progress" : "queued";
    return {
      fingerprint: ghStatus,
      payload: { name, head_sha: pipeline.commitSha, external_id: externalId, details_url: detailsUrl, status: ghStatus }
    };
  }
  const conclusion = checkConclusionFor(status);
  const errorText = run?.error || "";
  const annotations = conclusion === "failure" ? annotationsFromText(errorText) : [];
  return {
    fingerprint: `completed:${conclusion}`,
    payload: {
      name,
      head_sha: pipeline.commitSha,
      external_id: externalId,
      details_url: detailsUrl,
      status: "completed",
      conclusion,
      output: {
        title: titleFor(conclusion, status),
        summary: (errorText || `Job ${job.jobName} ${status}.`).slice(0, 1000),
        ...(annotations.length ? { annotations } : {})
      }
    }
  };
}

// Pipeline-level check: only for pipelines with no jobs (invalid config /
// blocked before compilation) so the failure still reaches the PR.
export function desiredPipelineCheck({ pipeline, parentRun, baseUrl }) {
  const errors = pipeline.configSource?.errors || [];
  const conclusion = "failure";
  return {
    fingerprint: `completed:${conclusion}`,
    payload: {
      name: `runyard/${pipeline.name}`,
      head_sha: pipeline.commitSha,
      external_id: pipeline.id,
      details_url: parentRun ? `${baseUrl}/app#runs/${parentRun.id}` : `${baseUrl}/app#repositories`,
      status: "completed",
      conclusion,
      output: {
        title: "CI configuration invalid",
        summary: (errors.length ? errors.join("\n") : parentRun?.error || "CI configuration could not be used").slice(0, 1000)
      }
    }
  };
}

function titleFor(conclusion, status = "") {
  if (conclusion === "success") return "Job succeeded";
  if (conclusion === "cancelled") return "Job cancelled";
  if (conclusion === "timed_out") return "Job timed out";
  if (conclusion === "skipped") return "Job skipped";
  if (conclusion === "action_required") {
    if (status === "infra_unavailable") return "CI infrastructure failure (not a code failure)";
    if (status === "blocked_by_preflight") return "Blocked before execution";
    return "Action required";
  }
  return "Job failed";
}

export function createCiReporter({
  env,
  githubApp,
  listRecentCiPipelines,
  listActiveCiPipelines = () => [],
  listCiJobs,
  getScmRepo,
  getRun,
  updateCiJobCheck,
  updateCiPipelineCheck,
  nowMs = () => Date.now(),
  logError = console.error
} = {}) {
  async function syncOne({ repo, pipeline, desired, ledger, updateLedger }) {
    if (ledger.checkState === desired.fingerprint) return { synced: false };
    // The retry budget is PER desired state, not lifetime: a transient
    // outage that exhausts retries while the job is queued must not block
    // reporting the later terminal conclusion.
    const attemptsSpent = ledger.checkAttemptsFor === desired.fingerprint ? ledger.checkAttempts || 0 : 0;
    if (attemptsSpent >= MAX_CHECK_SYNC_ATTEMPTS) return { synced: false, exhausted: true };
    try {
      const common = { installationId: repo.installationId, owner: repo.owner, repo: repo.name };
      let checkRunId = ledger.checkRunId;
      if (checkRunId) {
        await githubApp.updateCheckRun({ ...common, checkRunId, payload: desired.payload });
      } else {
        const created = await githubApp.createCheckRun({ ...common, payload: desired.payload });
        checkRunId = String(created?.id || "");
      }
      updateLedger({ checkRunId, checkState: desired.fingerprint, checkAttempts: 0, checkAttemptsFor: "", lastCheckError: "" });
      return { synced: true };
    } catch (error) {
      updateLedger({
        checkAttempts: attemptsSpent + 1,
        checkAttemptsFor: desired.fingerprint,
        lastCheckError: String(error.message || "check sync failed").slice(0, 500)
      });
      logError(`check sync failed for pipeline ${pipeline.id}:`, error.message);
      return { synced: false, error: error.message };
    }
  }

  // One reconciliation pass. Cheap when nothing changed (fingerprint match).
  // Scan set: recently-touched pipelines UNION currently-active ones — a
  // pipeline whose jobs run longer than the recency window must still get
  // live and final check updates (its conclusion also re-touches the row).
  async function sync() {
    if (!githubApp.configured()) return { synced: 0, failed: 0, skipped: "unconfigured" };
    const sinceIso = new Date(nowMs() - SCAN_WINDOW_MS).toISOString();
    let synced = 0;
    let failed = 0;
    const scanSet = new Map();
    for (const pipeline of [...listRecentCiPipelines({ sinceIso }), ...listActiveCiPipelines()]) {
      scanSet.set(pipeline.id, pipeline);
    }
    for (const pipeline of scanSet.values()) {
      if (!pipeline.commitSha) continue;
      const repo = getScmRepo(pipeline.repoId);
      if (!repo?.installationId || repo.provider !== "github") continue;
      const jobs = listCiJobs(pipeline.id);
      if (!jobs.length) {
        const parentRun = pipeline.runId ? getRun(pipeline.runId) : null;
        const desired = desiredPipelineCheck({ pipeline, parentRun, baseUrl: env.baseUrl });
        const result = await syncOne({
          repo,
          pipeline,
          desired,
          ledger: pipeline,
          updateLedger: (updates) => updateCiPipelineCheck(pipeline.id, updates)
        });
        result.synced ? (synced += 1) : result.error ? (failed += 1) : null;
        continue;
      }
      for (const job of jobs) {
        const run = job.runId ? getRun(job.runId) : null;
        const desired = desiredJobCheck({ job, run, pipeline, baseUrl: env.baseUrl });
        const result = await syncOne({
          repo,
          pipeline,
          desired,
          ledger: job,
          updateLedger: (updates) => updateCiJobCheck(job.id, updates)
        });
        result.synced ? (synced += 1) : result.error ? (failed += 1) : null;
      }
    }
    return { synced, failed };
  }

  // Operator reconciliation: reset exhausted retry counters for a pipeline
  // and sync again (POST /api/ci/pipelines/:id/sync-checks).
  async function resyncPipeline(pipelineId) {
    for (const job of listCiJobs(pipelineId)) {
      if (job.checkAttempts > 0) updateCiJobCheck(job.id, { checkAttempts: 0, checkAttemptsFor: "" });
    }
    updateCiPipelineCheck(pipelineId, { checkAttempts: 0, checkAttemptsFor: "" });
    return sync();
  }

  return { sync, resyncPipeline };
}
