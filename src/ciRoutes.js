import { actorName } from "./routeActors.js";
import { githubAppConfigHealth } from "./githubApp.js";
import { parseCiConfig, CI_CONFIG_PATH } from "./ciConfig.js";
import { validateTrustPolicyBody } from "./scmRecords.js";
import { isCiJobRun } from "./ciCapabilities.js";
import { RUN_TERMINAL } from "./runLifecyclePolicy.js";
import { deepLinks } from "./deepLinks.js";

// HTTP handlers for the CI platform (group `ci` in src/apiSurface.js):
// repository connections, pipelines/jobs, manual dispatch, webhook
// diagnostics, and the runner's JIT git-credential mint. The webhook ingress
// itself lives in src/githubWebhooks.js.

export function createCiHandlers({
  env,
  githubApp,
  ciTriggers,
  ciOrchestrator,
  ciReporter,
  webhookCounters,
  getScmRepo,
  listScmRepos,
  listScmInstallations,
  upsertScmInstallation,
  upsertScmRepo,
  setScmRepoEnabled,
  setScmRepoTrustPolicy,
  listScmWebhookDeliveries,
  countScmWebhookDeliveries,
  listCiPipelines,
  getCiPipeline,
  getCiPipelineByRunId,
  listCiJobs,
  getCiJobByRunId,
  getRun,
  transitionRun,
  addRunEvent,
  recordAudit,
  withRunLinks,
  nowIso = () => new Date().toISOString()
} = {}) {
  function setRepoEnabled(req, res, enable) {
    const repo = setScmRepoEnabled(String(req.query.repo || req.params.id), enable);
    if (!repo) return res.status(404).json({ error: "repository not connected" });
    recordAudit(actorName(req.token), enable ? "ci.repo.enabled" : "ci.repo.disabled", repo.id, { repo: repo.fullName });
    res.json({ repo });
  }

  function presentJob(job) {
    const run = job.runId ? getRun(job.runId) : null;
    return {
      ...job,
      run: run
        ? {
            id: run.id,
            status: run.status,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            error: run.error || null,
            deepLink: deepLinks.run(run.id)
          }
        : null
    };
  }

  function presentPipeline(pipeline, { includeJobs = true } = {}) {
    const parentRun = pipeline.runId ? getRun(pipeline.runId) : null;
    return {
      ...pipeline,
      run: parentRun
        ? {
            id: parentRun.id,
            status: parentRun.status,
            error: parentRun.error || null,
            createdAt: parentRun.createdAt,
            completedAt: parentRun.completedAt,
            deepLink: deepLinks.run(parentRun.id)
          }
        : null,
      ...(includeJobs ? { jobs: listCiJobs(pipeline.id).map(presentJob) } : {})
    };
  }

  return {
    // GET /api/ci/github-app — configuration health, never secret values.
    githubAppHealth(req, res) {
      res.json({ githubApp: githubAppConfigHealth(env), webhookPath: "/api/ci/webhooks/github" });
    },

    // GET /api/ci/repos
    listRepos(req, res) {
      const enabledOnly = req.query.enabled === "1";
      res.json({
        repos: listScmRepos({ enabledOnly }),
        installations: listScmInstallations()
      });
    },

    // GET /api/ci/repos/:id (id or owner/name via ?repo= is not needed —
    // the path accepts the row id; full names contain a slash, so they ride
    // the `repo` query param instead).
    getRepo(req, res) {
      const repo = getScmRepo(String(req.query.repo || req.params.id));
      if (!repo) return res.status(404).json({ error: "repository not connected" });
      res.json({
        repo,
        pipelines: listCiPipelines({ repoId: repo.id, limit: 20 }).map((p) => presentPipeline(p, { includeJobs: false }))
      });
    },

    // POST /api/ci/repos/:id/enable | /disable (admin). Two handlers so the
    // intent is bound to the ROUTE, never re-derived from the request path
    // (a trailing slash must not invert an admin action).
    enableRepo(req, res) {
      setRepoEnabled(req, res, true);
    },

    disableRepo(req, res) {
      setRepoEnabled(req, res, false);
    },

    // PATCH /api/ci/repos/:id/trust (admin)
    setRepoTrustPolicy(req, res) {
      const validated = validateTrustPolicyBody(req.body || {});
      if (!validated.ok) return res.status(400).json({ error: validated.error });
      const repo = setScmRepoTrustPolicy(String(req.query.repo || req.params.id), validated.value);
      if (!repo) return res.status(404).json({ error: "repository not connected" });
      recordAudit(actorName(req.token), "ci.repo.trust_updated", repo.id, { repo: repo.fullName, trustPolicy: repo.trustPolicy });
      res.json({ repo });
    },

    // POST /api/ci/repos/sync (admin) — pull installations + repositories
    // from the GitHub App (recovery for missed webhooks / first setup).
    async syncRepos(req, res) {
      if (!githubApp.configured()) return res.status(503).json({ error: "GitHub App is not configured" });
      const synced = { installations: 0, repos: 0 };
      const installations = await githubApp.listInstallations();
      for (const installation of installations) {
        upsertScmInstallation({
          installationId: installation.id,
          accountLogin: installation.account?.login || "",
          accountType: installation.account?.type || "",
          appId: installation.app_id || env.githubAppId,
          status: installation.suspended_at ? "suspended" : "active"
        });
        synced.installations += 1;
        const repos = await githubApp.listInstallationRepositories(installation.id);
        for (const repoPayload of repos) {
          const [owner, name] = String(repoPayload.full_name || "").split("/");
          if (!owner || !name) continue;
          upsertScmRepo({
            externalId: repoPayload.id,
            owner,
            name,
            fullName: repoPayload.full_name,
            cloneUrl: repoPayload.clone_url || `https://github.com/${repoPayload.full_name}.git`,
            defaultBranch: repoPayload.default_branch || "main",
            private: Boolean(repoPayload.private),
            installationId: installation.id
          });
          synced.repos += 1;
        }
      }
      recordAudit(actorName(req.token), "ci.repos.synced", null, synced);
      res.json({ synced, repos: listScmRepos() });
    },

    // GET /api/ci/repos/:id/config — inspect the validated CI configuration
    // at the trusted default branch (or ?ref=).
    async inspectRepoConfig(req, res) {
      const repo = getScmRepo(String(req.query.repo || req.params.id));
      if (!repo) return res.status(404).json({ error: "repository not connected" });
      if (!githubApp.configured()) return res.status(503).json({ error: "GitHub App is not configured" });
      const ref = String(req.query.ref || repo.defaultBranch);
      let sha = ref;
      try {
        if (!/^[0-9a-f]{40}$/.test(ref)) {
          const token = await githubApp.installationToken(repo.installationId, {
            repositories: [repo.name],
            permissions: { contents: "read" }
          });
          const { data } = await githubApp.request("GET", `/repos/${repo.fullName}/commits/${encodeURIComponent(ref)}`, { auth: token });
          sha = data?.sha || "";
        }
        if (!sha) return res.status(404).json({ error: `ref '${ref}' not found` });
        const fetched = await ciTriggers.fetchTrustedConfig(repo, sha);
        if (!fetched.found) {
          return res.json({ repo: repo.fullName, ref, sha, path: CI_CONFIG_PATH, present: false, valid: false, errors: [`no ${CI_CONFIG_PATH} at this revision`] });
        }
        const parsed = fetched.error ? { ok: false, errors: [fetched.error] } : parseCiConfig(fetched.text);
        res.json({
          repo: repo.fullName,
          ref,
          sha,
          path: CI_CONFIG_PATH,
          present: true,
          valid: parsed.ok,
          ...(parsed.ok ? { config: parsed.config } : { errors: parsed.errors })
        });
      } catch (error) {
        res.status(502).json({ error: `config inspection failed: ${error.message}` });
      }
    },

    // POST /api/ci/dispatch — manual CI dispatch. Body: {repo, ref?}.
    async dispatch(req, res) {
      const repoKey = String(req.body?.repo || "").trim();
      if (!repoKey) return res.status(400).json({ error: "repo is required (connected repository id or full name)" });
      if (!githubApp.configured()) return res.status(503).json({ error: "GitHub App is not configured" });
      const outcome = await ciTriggers.dispatchManual({
        repoIdOrFullName: repoKey,
        ref: String(req.body?.ref || "").trim(),
        requestedBy: actorName(req.token)
      });
      if (outcome.status !== "accepted") {
        const code = outcome.status === "invalid" ? 400 : outcome.status === "ignored" ? 409 : 502;
        return res.status(code).json({ error: outcome.reason || `dispatch ${outcome.status}` });
      }
      try {
        ciOrchestrator.advancePipeline(outcome.pipelineId);
      } catch {
        // the sweep will advance it
      }
      res.status(201).json({
        pipeline: presentPipeline(getCiPipeline(outcome.pipelineId)),
        run: withRunLinks(getRun(outcome.runId))
      });
    },

    // GET /api/ci/pipelines — recent pipelines (optionally per repo).
    listPipelines(req, res) {
      const repoKey = String(req.query.repo || "");
      let repoId = "";
      if (repoKey) {
        const repo = getScmRepo(repoKey);
        if (!repo) return res.status(404).json({ error: "repository not connected" });
        repoId = repo.id;
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      res.json({ pipelines: listCiPipelines({ repoId, limit }).map((p) => presentPipeline(p, { includeJobs: false })) });
    },

    // GET /api/ci/pipelines/:id — full provenance + job graph + check state.
    getPipeline(req, res) {
      const pipeline = getCiPipeline(req.params.id) || getCiPipelineByRunId(req.params.id);
      if (!pipeline) return res.status(404).json({ error: "pipeline not found" });
      const repo = getScmRepo(pipeline.repoId);
      res.json({ pipeline: presentPipeline(pipeline), repo: repo ? { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch } : null });
    },

    // POST /api/ci/pipelines/:id/cancel
    cancelPipeline(req, res) {
      const pipeline = getCiPipeline(req.params.id);
      if (!pipeline?.runId) return res.status(404).json({ error: "pipeline not found" });
      const result = transitionRun(pipeline.runId, "cancelled", { current_step: "cancelled", completed_at: nowIso() });
      if (!result.ok) return res.status(result.code).json({ error: result.error });
      if (!result.idempotent) {
        addRunEvent(pipeline.runId, "ci.pipeline.cancelled", `Pipeline cancelled by ${actorName(req.token)}`, {
          pipelineId: pipeline.id
        });
        recordAudit(actorName(req.token), "ci.pipeline.cancelled", pipeline.id, {});
      }
      try {
        ciOrchestrator.advancePipeline(pipeline.id);
      } catch {
        // the sweep will propagate the cancellation
      }
      res.json({ pipeline: presentPipeline(getCiPipeline(pipeline.id)) });
    },

    // POST /api/ci/pipelines/:id/rerun
    async rerunPipeline(req, res) {
      const outcome = await ciTriggers.rerunPipeline(req.params.id, { requestedBy: actorName(req.token) });
      if (outcome.status !== "accepted") {
        const code = outcome.status === "invalid" ? 404 : 502;
        return res.status(code).json({ error: outcome.reason || `rerun ${outcome.status}` });
      }
      try {
        ciOrchestrator.advancePipeline(outcome.pipelineId);
      } catch {
        // the sweep will advance it
      }
      res.status(201).json({ pipeline: presentPipeline(getCiPipeline(outcome.pipelineId)) });
    },

    // POST /api/ci/pipelines/:id/sync-checks (admin) — operator
    // reconciliation after a reporter outage: reset retry caps + resync.
    async syncPipelineChecks(req, res) {
      const pipeline = getCiPipeline(req.params.id);
      if (!pipeline) return res.status(404).json({ error: "pipeline not found" });
      const result = await ciReporter.resyncPipeline(pipeline.id);
      recordAudit(actorName(req.token), "ci.checks.resynced", pipeline.id, result);
      res.json({ pipeline: presentPipeline(getCiPipeline(pipeline.id)), result });
    },

    // GET /api/ci/deliveries (admin) — webhook delivery diagnostics.
    listDeliveries(req, res) {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const status = String(req.query.status || "");
      res.json({ deliveries: listScmWebhookDeliveries({ limit, ...(status ? { status } : {}) }) });
    },

    // GET /api/ci/diagnostics (admin) — low-cardinality operator counters.
    diagnostics(req, res) {
      const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const active = listCiPipelines({ limit: 200 }).filter((p) => {
        const run = p.runId ? getRun(p.runId) : null;
        return run && !RUN_TERMINAL.has(run.status);
      });
      // Queue latency + check lag across active pipelines' jobs.
      let queuedJobs = 0;
      let checkLagged = 0;
      let queueLatencyMsMax = 0;
      for (const pipeline of active) {
        for (const job of listCiJobs(pipeline.id)) {
          const run = job.runId ? getRun(job.runId) : null;
          if (run && ["queued", "assigned"].includes(run.status)) {
            queuedJobs += 1;
            queueLatencyMsMax = Math.max(queueLatencyMsMax, Date.now() - Date.parse(run.createdAt));
          }
          if (job.checkAttempts > 0) checkLagged += 1;
        }
      }
      res.json({
        webhooks: {
          sinceBoot: webhookCounters,
          last24h: {
            total: countScmWebhookDeliveries({ sinceIso }),
            accepted: countScmWebhookDeliveries({ status: "accepted", sinceIso }),
            ignored: countScmWebhookDeliveries({ status: "ignored", sinceIso }),
            invalid: countScmWebhookDeliveries({ status: "invalid", sinceIso })
          }
        },
        pipelines: { active: active.length },
        jobs: { queued: queuedJobs, queueLatencyMsMax },
        checks: { pipelinesWithRetryingChecks: checkLagged },
        githubApp: { configured: githubApp.configured() }
      });
    },

    // POST /api/ci/runs/:id/git-credential (runner-owner) — mint a short-
    // lived, repo-scoped, read-only token for the job's git fetch. Never
    // stored; the event trail carries metadata only.
    async mintGitCredential(req, res) {
      const run = getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "run not found" });
      if (!isCiJobRun(run)) return res.status(400).json({ error: "not a CI job run" });
      if (RUN_TERMINAL.has(run.status)) return res.status(409).json({ error: "run is already terminal" });
      const job = getCiJobByRunId(run.id);
      const pipeline = job ? getCiPipeline(job.pipelineId) : null;
      const repo = pipeline ? getScmRepo(pipeline.repoId) : null;
      if (!repo) return res.status(404).json({ error: "no connected repository for this run" });
      if (!githubApp.configured() || !repo.installationId) {
        return res.json({ token: null, reason: "no GitHub App credential available; fetch anonymously" });
      }
      try {
        const token = await githubApp.gitFetchToken(repo.installationId, repo.name);
        addRunEvent(run.id, "ci.git_credential.minted", `Minted read-only git credential for ${repo.fullName}`, {
          repo: repo.fullName,
          scope: "contents:read"
        });
        res.json({ token, expiresInMinutes: 55 });
      } catch (error) {
        res.status(502).json({ error: `credential mint failed: ${error.message}` });
      }
    }
  };
}
