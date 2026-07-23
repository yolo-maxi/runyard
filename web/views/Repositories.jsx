import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiPost, apiPatch } from "../lib/api.js";
import { deepLinks } from "../lib/router.js";
import { meIsAdmin } from "../lib/me.js";
import { relativeTime } from "../lib/format.js";
import { toast } from "../lib/toast.js";
import { Breadcrumbs, StatusBadge, Toolbar } from "../components/ui.jsx";
import { CiJobList, CiProvenance } from "../components/CiParts.jsx";

// Repositories / CI overview + repository detail. GitHub remains the
// canonical repository host; these pages manage RunYard's CI connection:
// which repos are enabled, their trust policy, connection health, and the
// recent pipelines with their canonical runs.

function trustLabel(repo) {
  const trust = repo.trustPolicy || {};
  if (trust.level !== "trusted") return "untrusted";
  return trust.allowNative ? "trusted · native allowed" : "trusted";
}

function GithubAppHealth({ admin }) {
  const { data, error } = useQuery({
    queryKey: ["ci-github-app"],
    queryFn: () => api("/api/ci/github-app"),
    enabled: admin,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev
  });
  if (!admin || (!data && !error)) return null;
  if (error) return <p className="muted">GitHub App health unavailable: {error.message}</p>;
  const app = data.githubApp || {};
  return (
    <p className="ci-app-health">
      <span className={`chip ${app.configured ? "chip-branch" : "chip-version"}`} title={app.configured ? "App id, private key, and webhook secret are configured" : "Set RUNYARD_GITHUB_APP_ID / _PRIVATE_KEY_PATH / _WEBHOOK_SECRET"}>
        GitHub App {app.configured ? "configured" : "not configured"}
      </span>
      {app.appId ? <span className="chip chip-runner chip--id">app id {app.appId}</span> : null}
      <span className="chip chip-project chip--id" title="Paste this webhook URL (absolute) into the GitHub App settings">webhook {data.webhookPath}</span>
    </p>
  );
}

function PipelineRow({ pipeline }) {
  const trigger = pipeline.trigger || {};
  const status = pipeline.run?.status || "unknown";
  return (
    <tr>
      <td data-label="Pipeline">
        {pipeline.run ? <a href={deepLinks.run(pipeline.run.id)}>{pipeline.id}</a> : pipeline.id}
      </td>
      <td data-label="Status"><StatusBadge value={status} /></td>
      <td data-label="Trigger">
        {trigger.event || "?"}{trigger.prNumber ? ` PR #${trigger.prNumber}` : ""}{trigger.ref ? ` · ${trigger.ref}` : ""}
      </td>
      <td data-label="Commit"><code>{(pipeline.commitSha || "").slice(0, 10) || "—"}</code></td>
      <td data-label="When" title={pipeline.createdAt}>{relativeTime(pipeline.createdAt, Date.now())}</td>
    </tr>
  );
}

export function Repositories({ me }) {
  const admin = meIsAdmin(me);
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["ci-repos"],
    queryFn: () => api("/api/ci/repos"),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev
  });
  const repos = data?.repos || [];
  const installations = data?.installations || [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ci-repos"] });

  async function setEnabled(repo, enable) {
    try {
      await apiPost(`/api/ci/repos/${encodeURIComponent(repo.id)}/${enable ? "enable" : "disable"}`, {});
      toast(`${repo.fullName} CI ${enable ? "enabled" : "disabled"}`, "ok");
      refresh();
    } catch (err) {
      toast(err.message || "Update failed", "error");
    }
  }

  async function syncNow() {
    try {
      const result = await apiPost("/api/ci/repos/sync", {});
      toast(`Synced ${result.synced.installations} installation(s), ${result.synced.repos} repo(s)`, "ok");
      refresh();
    } catch (err) {
      toast(err.message || "Sync failed", "error");
    }
  }

  return (
    <>
      <Toolbar title="Repositories" shareHash={deepLinks.repositories()}>
        {admin ? <button className="button" onClick={syncNow} title="Pull installations + repositories from the GitHub App">Sync from GitHub</button> : null}
      </Toolbar>
      <section className="panel">
        <GithubAppHealth admin={admin} />
        {isLoading && !data ? <p className="muted">Loading repositories…</p> : null}
        {error ? <p className="muted">Could not load repositories: {error.message}</p> : null}
        {!isLoading && !error && !repos.length ? (
          <div className="empty">
            <p>No repositories connected.</p>
            <p className="muted">
              Install the RunYard GitHub App on a repository, then {admin ? <>press <strong>Sync from GitHub</strong></> : <>ask an admin to sync</>}. Repositories connect <strong>disabled</strong> — CI never starts without an explicit enable.
              {installations.length ? ` ${installations.length} installation(s) are connected already.` : ""}
            </p>
          </div>
        ) : null}
        {repos.length ? (
          <table className="table ci-repos-table">
            <thead>
              <tr><th>Repository</th><th>CI</th><th>Trust</th><th>Default branch</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo.id}>
                  <td data-label="Repository">
                    <a href={deepLinks.repository(repo.id)}>{repo.fullName}</a>
                    {repo.private ? <span className="muted"> · private</span> : null}
                  </td>
                  <td data-label="CI"><StatusBadge value={repo.enabled ? "enabled" : "disabled"} /></td>
                  <td data-label="Trust">{trustLabel(repo)}</td>
                  <td data-label="Default branch"><code>{repo.defaultBranch}</code></td>
                  <td data-label="Actions">
                    {admin ? (
                      <button className="button" onClick={() => setEnabled(repo, !repo.enabled)}>
                        {repo.enabled ? "Disable CI" : "Enable CI"}
                      </button>
                    ) : (
                      <span className="muted">admin only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

function ConfigStatus({ repoId }) {
  const { data, error } = useQuery({
    queryKey: ["ci-repo-config", repoId],
    queryFn: () => api(`/api/ci/repos/${encodeURIComponent(repoId)}/config`),
    retry: false
  });
  if (error) return <p className="muted ci-config-status">Config check unavailable: {error.message}</p>;
  if (!data) return <p className="muted ci-config-status">Checking .runyard/ci.yml…</p>;
  if (!data.present) {
    return (
      <div className="empty">
        <p>No <code>.runyard/ci.yml</code> on <code>{data.ref}</code>.</p>
        <p className="muted">Commit one to the default branch to activate CI — see the docs for the schema.</p>
      </div>
    );
  }
  if (!data.valid) {
    return (
      <div className="ci-config-errors">
        <p><strong>Configuration invalid</strong> at <code>{(data.sha || "").slice(0, 12)}</code>:</p>
        <ul>{(data.errors || []).map((err, index) => <li key={index}><code>{err}</code></li>)}</ul>
      </div>
    );
  }
  const jobs = data.config?.jobs || [];
  return (
    <p className="ci-config-status">
      <span className="chip chip-branch">config valid</span>{" "}
      {jobs.length} job{jobs.length === 1 ? "" : "s"}: {jobs.map((job) => job.jobName).join(", ")} · pinned <code>{(data.sha || "").slice(0, 12)}</code>
    </p>
  );
}

export function RepositoryDetail({ id, me }) {
  const admin = meIsAdmin(me);
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["ci-repo", id],
    queryFn: () => api(`/api/ci/repos/${encodeURIComponent(id)}`),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev
  });

  if (isLoading && !data) return <section className="panel"><p className="muted">Loading repository…</p></section>;
  if (error) return <section className="panel"><h2>Repository not found</h2><p className="muted">{error.message}</p></section>;

  const repo = data.repo;
  const pipelines = data.pipelines || [];

  async function setTrust(level) {
    try {
      await apiPatch(`/api/ci/repos/${encodeURIComponent(repo.id)}/trust`, { level });
      toast(`${repo.fullName} is now ${level}`, "ok");
      queryClient.invalidateQueries({ queryKey: ["ci-repo", id] });
    } catch (err) {
      toast(err.message || "Trust update failed", "error");
    }
  }

  return (
    <>
      <Breadcrumbs items={[
        { label: "Repositories", href: deepLinks.repositories() },
        { label: repo.fullName, href: deepLinks.repository(repo.id), current: true }
      ]} />
      <Toolbar title={repo.fullName} shareHash={deepLinks.repository(repo.id)} />
      <section className="panel">
        <p className="ci-repo-chips">
          <StatusBadge value={repo.enabled ? "enabled" : "disabled"} />
          <span className="chip chip-branch" title="Default branch (the trusted config source for PRs)"><code>{repo.defaultBranch}</code></span>
          <span className="chip chip-project" title="Trust policy governs secrets + native execution">{trustLabel(repo)}</span>
          {repo.installationId ? <span className="chip chip-runner chip--id" title="GitHub App installation id">install {repo.installationId}</span> : <span className="chip chip-version" title="No installation — CI cannot fetch config or report checks">no installation</span>}
        </p>
        {admin ? (
          <p className="ci-repo-actions">
            <button className="button" onClick={() => setTrust(repo.trustPolicy?.level === "trusted" ? "untrusted" : "trusted")}>
              {repo.trustPolicy?.level === "trusted" ? "Mark untrusted" : "Mark trusted"}
            </button>
          </p>
        ) : null}
        <ConfigStatus repoId={repo.id} />
      </section>
      <section className="panel">
        <h3>Recent pipelines</h3>
        {!pipelines.length ? (
          <div className="empty">
            <p>No pipelines yet.</p>
            <p className="muted">Push to a configured branch, open a PR, or dispatch manually: <code>runyard ci dispatch {repo.fullName}</code>.</p>
          </div>
        ) : (
          <table className="table ci-pipelines-table">
            <thead><tr><th>Pipeline</th><th>Status</th><th>Trigger</th><th>Commit</th><th>When</th></tr></thead>
            <tbody>{pipelines.map((pipeline) => <PipelineRow key={pipeline.id} pipeline={pipeline} />)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

// CI section body for the run detail page: works for both the pipeline
// parent run and individual job runs.
export function RunCiSection({ run }) {
  const ci = run?.input?.__ci;
  const { data, error } = useQuery({
    queryKey: ["ci-pipeline-for-run", run?.id],
    queryFn: () => api(`/api/ci/pipelines/${encodeURIComponent(ci.pipelineId || run.id)}`),
    enabled: Boolean(ci),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev
  });
  if (!ci) return null;
  if (error) return <p className="muted">CI provenance unavailable: {error.message}</p>;
  if (!data) return <p className="muted">Loading pipeline…</p>;
  return (
    <>
      <CiProvenance pipeline={data.pipeline} repo={data.repo} />
      <CiJobList pipeline={data.pipeline} />
    </>
  );
}
