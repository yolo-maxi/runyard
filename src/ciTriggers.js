import {
  CI_CONFIG_PATH,
  CI_CONFIG_MAX_BYTES,
  ciConcurrencyKey,
  ciConfigMatches,
  parseCiConfig
} from "./ciConfig.js";
import { CI_PIPELINE_CAPABILITY_SLUG } from "./ciCapabilities.js";
import { deepLinks } from "./deepLinks.js";

// Trigger compilation: turn a verified GitHub event (or a manual dispatch)
// into a CI pipeline — trusted config fetch, validation, trust context, job
// compilation, concurrency/cancel-superseded, and the canonical parent run.
// Pure extraction helpers are exported for tests; everything with I/O lives
// on the factory.

const MAX_CHANGED_PATHS = 300;

// --- pure payload extraction ------------------------------------------------

export function extractPushTrigger(payload, { deliveryId = "", receivedAt = "" } = {}) {
  const changed = new Set();
  const commits = payload.commits || [];
  for (const commit of commits) {
    for (const key of ["added", "modified", "removed"]) {
      for (const file of commit[key] || []) {
        if (changed.size >= MAX_CHANGED_PATHS) break;
        changed.add(file);
      }
    }
  }
  // GitHub truncates commits[] (~20 entries) and omits it on force pushes —
  // in those cases the changed-file list is INCOMPLETE and path filters must
  // fail open (run CI) rather than silently skip a change that mattered.
  const changedPathsTruncated =
    Boolean(payload.forced) || !commits.length || commits.length >= 20 || changed.size >= MAX_CHANGED_PATHS;
  return {
    changedPathsTruncated,
    provider: "github",
    event: "push",
    action: "",
    deliveryId,
    receivedAt,
    repoFullName: payload.repository?.full_name || "",
    ref: payload.ref || "",
    headSha: payload.after || "",
    baseSha: payload.before || "",
    sender: payload.sender?.login || "",
    changedPaths: [...changed],
    deleted: Boolean(payload.deleted)
  };
}

export function extractPullRequestTrigger(payload, { deliveryId = "", receivedAt = "" } = {}) {
  const pr = payload.pull_request || {};
  return {
    provider: "github",
    event: "pull_request",
    action: payload.action || "",
    deliveryId,
    receivedAt,
    repoFullName: payload.repository?.full_name || "",
    prNumber: pr.number || 0,
    ref: pr.head?.ref || "",
    baseRef: pr.base?.ref || "",
    headSha: pr.head?.sha || "",
    baseSha: pr.base?.sha || "",
    sender: payload.sender?.login || "",
    headRepoFullName: pr.head?.repo?.full_name || "",
    draft: Boolean(pr.draft)
  };
}

// A PR from a different head repository (fork) is ALWAYS untrusted, on top of
// the repository's own trust policy level.
export function triggerTrustContext(trigger, repo) {
  const fork = trigger.event === "pull_request" && trigger.headRepoFullName &&
    trigger.headRepoFullName !== trigger.repoFullName;
  const untrusted = Boolean(fork) || repo.trustPolicy.level !== "trusted";
  return { fork: Boolean(fork), untrusted };
}

// Compile validated config jobs for one trigger's trust context. Untrusted
// contexts get no secrets; native jobs in untrusted contexts are policy-
// denied at compile time (never queued).
export function compileCiJobs(config, { untrusted }) {
  return config.jobs.map((job) => {
    const spec = { ...job.spec };
    const compiled = {
      jobName: job.jobName,
      needs: job.needs,
      executor: job.executor,
      required: job.required,
      spec
    };
    if (untrusted) {
      if (spec.secrets?.length) {
        spec.secrets = [];
        spec.secretsDenied = "untrusted context: repository secrets are not delivered";
      }
      if (job.executor === "native") {
        compiled.policyDenied = "policy: native host execution is not allowed for untrusted contexts";
      }
    }
    return compiled;
  });
}

export function ciTestedFromTrigger(trigger) {
  if (trigger.event === "pull_request") {
    // The runner constructs the merge candidate deterministically from these
    // pinned SHAs; a conflict is a first-class blocked conclusion.
    return { strategy: "merge", headSha: trigger.headSha, baseSha: trigger.baseSha, ref: trigger.ref, baseRef: trigger.baseRef };
  }
  return { strategy: "head", headSha: trigger.headSha, ref: trigger.ref };
}

// --- factory ----------------------------------------------------------------

export function createCiTriggers({
  env,
  githubApp,
  getScmRepo,
  getCapability,
  createRun,
  transitionRun,
  addRunEvent,
  recordAudit,
  createCiPipeline,
  setCiPipelineRun,
  listCiJobs,
  markCiJobPhase,
  getCiJob,
  getCiPipeline,
  listActiveCiPipelines,
  markCiPipelineSuperseded,
  getRun,
  nowIso = () => new Date().toISOString(),
  logError = console.error
} = {}) {
  // Trusted config fetch, pinned to an exact commit SHA. Returns
  // { found, text?, sha, error? }; a missing file is a normal "repo has no
  // CI" outcome, not an error.
  async function fetchTrustedConfig(repo, sha) {
    const token = await githubApp.installationToken(repo.installationId, {
      repositories: [repo.name],
      permissions: { contents: "read" }
    });
    try {
      const { data } = await githubApp.request(
        "GET",
        `/repos/${repo.fullName}/contents/${CI_CONFIG_PATH}?ref=${encodeURIComponent(sha)}`,
        { auth: token }
      );
      if (!data?.content) return { found: false, sha };
      if ((data.size || 0) > CI_CONFIG_MAX_BYTES) {
        return { found: true, sha, error: `config exceeds ${CI_CONFIG_MAX_BYTES} bytes` };
      }
      return { found: true, sha, text: Buffer.from(data.content, "base64").toString("utf8") };
    } catch (error) {
      if (error.status === 404) return { found: false, sha };
      throw error;
    }
  }

  function pipelineOrigin(trigger) {
    return {
      type: "ci",
      provider: trigger.provider,
      event: trigger.event,
      deliveryId: trigger.deliveryId || "",
      repo: trigger.repoFullName,
      sender: trigger.sender || ""
    };
  }

  // Create the canonical parent run + pipeline row (+ jobs) in one place.
  // The parent is transitioned queued->running in the same tick, so the
  // runner claim path can never take it (its capability also requires the
  // hub-only tag as a second lock).
  function materializePipeline({ repo, trigger, config, configSource, jobs, concurrencyKey, failure = null }) {
    const capability = getCapability(CI_PIPELINE_CAPABILITY_SLUG);
    if (!capability) throw new Error("ci-pipeline capability is not seeded");
    const pipeline = createCiPipeline({
      repoId: repo.id,
      runId: null,
      name: config?.name || "ci",
      trigger,
      configSource,
      tested: ciTestedFromTrigger(trigger),
      commitSha: trigger.headSha || "",
      concurrencyKey,
      jobs
    });
    const parentRun = createRun(capability, {
      __ci: {
        role: "pipeline",
        pipelineId: pipeline.id,
        repoFullName: repo.fullName,
        event: trigger.event,
        headSha: trigger.headSha || "",
        prNumber: trigger.prNumber || null
      }
    }, {
      requestedBy: trigger.sender ? `github:${trigger.sender}` : "github",
      origin: pipelineOrigin(trigger)
    });
    setCiPipelineRun(pipeline.id, parentRun.id);
    transitionRun(parentRun.id, "running", { current_step: "orchestrating", started_at: nowIso() });
    addRunEvent(parentRun.id, "ci.pipeline.created", `CI pipeline for ${repo.fullName} ${describeTrigger(trigger)}`, {
      pipelineId: pipeline.id,
      "cicd.pipeline.name": pipeline.name,
      "cicd.pipeline.run.id": pipeline.id,
      event: trigger.event,
      headSha: trigger.headSha || "",
      configSha: configSource.sha || "",
      jobs: jobs.map((job) => job.jobName)
    });
    if (failure) {
      transitionRun(parentRun.id, "blocked_by_preflight", {
        current_step: "config invalid",
        error: failure,
        completed_at: nowIso()
      });
      addRunEvent(parentRun.id, "ci.pipeline.blocked", failure, { pipelineId: pipeline.id, "cicd.pipeline.result": "error" });
    }
    return { pipeline: getCiPipeline(pipeline.id), parentRun: getRun(parentRun.id) };
  }

  // Ordering guard: webhook handlers interleave across awaited config
  // fetches and GitHub does not guarantee delivery order, so "the pipeline I
  // just created" is NOT necessarily the newest work on this key. Compare
  // trigger receipt times: only strictly-older active pipelines are
  // superseded; if a NEWER active pipeline already exists, the new pipeline
  // supersedes ITSELF instead of cancelling fresher work.
  function cancelSupersededPipelines(newPipeline, concurrencyKey) {
    const newReceivedAt = Date.parse(newPipeline.trigger?.receivedAt || newPipeline.createdAt) || 0;
    const superseded = [];
    for (const active of listActiveCiPipelines({ concurrencyKey })) {
      if (active.id === newPipeline.id) continue;
      const activeReceivedAt = Date.parse(active.trigger?.receivedAt || active.createdAt) || 0;
      const older = active.id === newPipeline.id ? null : activeReceivedAt <= newReceivedAt ? active : newPipeline;
      const newer = older === active ? newPipeline : active;
      markCiPipelineSuperseded(older.id, newer.id);
      const result = transitionRun(older.runId, "cancelled", {
        current_step: "superseded",
        completed_at: nowIso()
      });
      if (result.ok && !result.idempotent) {
        addRunEvent(older.runId, "ci.pipeline.superseded", `Superseded by newer pipeline ${newer.id} on the same concurrency key`, {
          pipelineId: older.id,
          supersededBy: newer.id,
          concurrencyKey
        });
      }
      superseded.push(older.id);
      if (older === newPipeline) break;
    }
    return superseded;
  }

  // Core: one verified trigger -> pipeline (or an ignored/blocked outcome).
  async function createPipelineForTrigger(trigger) {
    const repo = getScmRepo(trigger.repoFullName);
    if (!repo) return { status: "invalid", reason: `repository ${trigger.repoFullName} is not connected` };
    if (!repo.enabled) return { status: "ignored", reason: `repository ${trigger.repoFullName} is not enabled for CI` };
    if (trigger.event === "push" && trigger.deleted) return { status: "ignored", reason: "ref deletion" };
    if (trigger.event === "push" && /^0+$/.test(trigger.headSha || "")) {
      return { status: "ignored", reason: "push with zero head sha" };
    }
    if (!trigger.headSha) return { status: "invalid", reason: "trigger carries no head sha" };

    // Trusted config revision: the pushed commit itself for pushes (the
    // pusher has write access), the BASE branch head for pull requests —
    // never the PR head (fork security boundary).
    const configSha = trigger.event === "pull_request" ? trigger.baseSha : trigger.headSha;
    let fetched;
    try {
      fetched = await fetchTrustedConfig(repo, configSha);
    } catch (error) {
      logError(`CI config fetch failed for ${repo.fullName}@${configSha}:`, error.message);
      return { status: "error", reason: `config fetch failed: ${error.message}` };
    }
    if (!fetched.found) return { status: "ignored", reason: `no ${CI_CONFIG_PATH} at trusted revision` };

    const configSource = {
      path: CI_CONFIG_PATH,
      ref: trigger.event === "pull_request" ? trigger.baseRef : trigger.ref,
      sha: configSha
    };
    const parsed = fetched.error ? { ok: false, errors: [fetched.error] } : parseCiConfig(fetched.text);
    if (!parsed.ok) {
      // Invalid config is a first-class blocked pipeline with evidence — it
      // must reach GitHub as a failed runyard/ci check, not vanish.
      const { pipeline, parentRun } = materializePipeline({
        repo,
        trigger,
        config: null,
        configSource: { ...configSource, errors: parsed.errors.slice(0, 20) },
        jobs: [],
        concurrencyKey: ciConcurrencyKey({ repoFullName: repo.fullName, config: null, trigger }),
        failure: `CI config invalid: ${parsed.errors.join("; ")}`.slice(0, 2000)
      });
      return { status: "accepted", outcome: "config_invalid", pipelineId: pipeline.id, runId: parentRun.id };
    }

    const match = ciConfigMatches(parsed.config, trigger);
    if (!match.matched) return { status: "ignored", reason: match.reason };

    const trust = triggerTrustContext(trigger, repo);
    const jobs = compileCiJobs(parsed.config, trust);
    const concurrencyKey = ciConcurrencyKey({ repoFullName: repo.fullName, config: parsed.config, trigger });
    const { pipeline, parentRun } = materializePipeline({
      repo,
      trigger: { ...trigger, fork: trust.fork, untrusted: trust.untrusted },
      config: parsed.config,
      configSource,
      jobs,
      concurrencyKey
    });
    // Policy-denied jobs land as pre-dispatch skips with an explicit reason.
    for (const job of listCiJobs(pipeline.id)) {
      const compiled = jobs.find((j) => j.jobName === job.jobName);
      if (compiled?.policyDenied) markCiJobPhase(job.id, "skipped", compiled.policyDenied);
    }
    const superseded = parsed.config.concurrency.cancelInProgress
      ? cancelSupersededPipelines(pipeline, concurrencyKey)
      : [];
    return {
      status: "accepted",
      outcome: "pipeline",
      pipelineId: pipeline.id,
      runId: parentRun.id,
      supersededPipelineIds: superseded,
      deepLink: deepLinks.run(parentRun.id)
    };
  }

  // Manual dispatch (API/CLI): resolve the ref to an exact sha via the
  // provider, then run the same trusted pipeline path.
  async function dispatchManual({ repoIdOrFullName, ref = "", requestedBy = "" }) {
    const repo = getScmRepo(repoIdOrFullName);
    if (!repo) return { status: "invalid", reason: "repository not connected" };
    if (!repo.enabled) return { status: "invalid", reason: "repository is not enabled for CI" };
    const targetRef = ref || repo.defaultBranch;
    let sha;
    try {
      const token = await githubApp.installationToken(repo.installationId, {
        repositories: [repo.name],
        permissions: { contents: "read" }
      });
      const { data } = await githubApp.request(
        "GET",
        `/repos/${repo.fullName}/commits/${encodeURIComponent(targetRef)}`,
        { auth: token }
      );
      sha = data?.sha || "";
    } catch (error) {
      return { status: "error", reason: `could not resolve ref '${targetRef}': ${error.message}` };
    }
    if (!sha) return { status: "error", reason: `ref '${targetRef}' resolved to no commit` };
    const trigger = {
      provider: "github",
      event: "manual",
      action: "",
      deliveryId: "",
      receivedAt: nowIso(),
      repoFullName: repo.fullName,
      ref: targetRef,
      headSha: sha,
      baseSha: "",
      sender: requestedBy
    };
    recordAudit(requestedBy || "system:ci", "ci.dispatch", repo.id, { repo: repo.fullName, ref: targetRef, sha });
    return createPipelineForTrigger(trigger);
  }

  // Rerun: a fresh pipeline with the original trigger provenance (plus a
  // rerunOf marker). The original pipeline/run stays intact as evidence.
  async function rerunPipeline(pipelineId, { requestedBy = "" } = {}) {
    const original = getCiPipeline(pipelineId);
    if (!original) return { status: "invalid", reason: "pipeline not found" };
    const trigger = {
      ...original.trigger,
      receivedAt: nowIso(),
      deliveryId: "",
      rerunOfPipelineId: original.id,
      sender: requestedBy || original.trigger.sender || ""
    };
    recordAudit(requestedBy || "system:ci", "ci.rerun", original.id, { repo: trigger.repoFullName });
    return createPipelineForTrigger(trigger);
  }

  // check_run.rerequested for a check owned by this App: external_id carries
  // our job (or pipeline) row id; rerun that job's pipeline.
  async function handleCheckRerequested(payload) {
    const externalId = payload.check_run?.external_id || "";
    if (!externalId) return { status: "ignored", reason: "check has no external id" };
    const job = getCiJob(externalId);
    const pipelineId = job ? job.pipelineId : getCiPipeline(externalId) ? externalId : "";
    if (!pipelineId) return { status: "ignored", reason: "check is not owned by this hub" };
    return rerunPipeline(pipelineId, { requestedBy: payload.sender?.login ? `github:${payload.sender.login}` : "github" });
  }

  return {
    createPipelineForTrigger,
    dispatchManual,
    fetchTrustedConfig,
    handleCheckRerequested,
    rerunPipeline
  };
}

function describeTrigger(trigger) {
  if (trigger.event === "pull_request") return `PR #${trigger.prNumber} (${trigger.action})`;
  if (trigger.event === "push") return `push to ${trigger.ref}`;
  return trigger.event;
}
