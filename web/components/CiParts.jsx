import { deepLinks } from "../lib/router.js";
import { StatusBadge } from "./ui.jsx";

// Presentational CI pieces (SSR-safe, no fetching): job DAG rows for a
// pipeline, provenance strip, and check-state chips. Data shapes come from
// GET /api/ci/pipelines/:id (see src/ciRoutes.js presentPipeline).

export function ciJobState(job) {
  if (job.run) return job.run.status;
  return job.phase;
}

function CheckChip({ job }) {
  if (!job.checkState) return null;
  const failed = Boolean(job.lastCheckError) && job.checkAttempts > 0;
  const label = failed ? `check retrying (${job.checkAttempts})` : `check ${job.checkState.replace("completed:", "")}`;
  return (
    <span className={`chip chip-version ci-check-chip${failed ? " ci-check-lagging" : ""}`} title={failed ? job.lastCheckError : `GitHub check state: ${job.checkState}`}>
      {label}
    </span>
  );
}

export function CiJobList({ pipeline }) {
  const jobs = pipeline?.jobs || [];
  if (!jobs.length) {
    return (
      <div className="empty">
        <p>No jobs were compiled for this pipeline.</p>
        <p className="muted">Usually an invalid <code>.runyard/ci.yml</code> — the error is on the run banner and the GitHub check.</p>
      </div>
    );
  }
  return (
    <ul className="ci-job-list">
      {jobs.map((job) => {
        const state = ciJobState(job);
        return (
          <li key={job.id} className="ci-job-row" data-ci-job={job.jobName}>
            <span className="ci-job-name">
              {job.run ? <a href={deepLinks.run(job.run.id)} title={`Open job run ${job.run.id}`}>{job.jobName}</a> : job.jobName}
            </span>
            <StatusBadge value={state} />
            <span className="ci-job-meta muted">
              {job.needs?.length ? `needs ${job.needs.join(", ")} · ` : ""}
              {job.executor}
              {job.required === false ? " · optional" : ""}
              {job.phaseReason ? ` · ${job.phaseReason}` : ""}
            </span>
            <CheckChip job={job} />
          </li>
        );
      })}
    </ul>
  );
}

export function CiProvenance({ pipeline, repo }) {
  if (!pipeline) return null;
  const trigger = pipeline.trigger || {};
  const tested = pipeline.tested || {};
  const configSource = pipeline.configSource || {};
  const shortSha = (sha) => (sha ? String(sha).slice(0, 12) : "—");
  return (
    <dl className="ci-provenance">
      <dt>Trigger</dt>
      <dd>
        {trigger.event || "unknown"}
        {trigger.prNumber ? ` · PR #${trigger.prNumber}` : ""}
        {trigger.ref ? ` · ${trigger.ref}` : ""}
        {trigger.sender ? ` · by ${trigger.sender}` : ""}
        {trigger.fork ? " · fork (untrusted)" : trigger.untrusted ? " · untrusted" : ""}
      </dd>
      <dt>Repository</dt>
      <dd>{repo?.fullName ? <a href={deepLinks.repository(repo.id)}>{repo.fullName}</a> : pipeline.repoId}</dd>
      <dt>Head commit</dt>
      <dd><code title={trigger.headSha || ""}>{shortSha(trigger.headSha)}</code></dd>
      <dt>Tested</dt>
      <dd>
        {tested.strategy === "merge"
          ? <>merge candidate of <code title={tested.headSha}>{shortSha(tested.headSha)}</code> into <code title={tested.baseSha}>{shortSha(tested.baseSha)}</code></>
          : <>head commit <code title={tested.headSha}>{shortSha(tested.headSha)}</code></>}
      </dd>
      <dt>Config</dt>
      <dd><code>{configSource.path || ".runyard/ci.yml"}</code> @ <code title={configSource.sha}>{shortSha(configSource.sha)}</code> ({configSource.ref || "trusted base"})</dd>
      {pipeline.supersededBy ? (
        <>
          <dt>Superseded</dt>
          <dd className="muted">replaced by a newer pipeline on the same concurrency key</dd>
        </>
      ) : null}
    </dl>
  );
}
