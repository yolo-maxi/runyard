// Shared identifiers for the CI platform's two internal capabilities.
//
// ci-pipeline: the parent run of one CI trigger. Hub-orchestrated — it
// requires the `runyard-hub` tag no runner ever advertises AND is transitioned
// queued->running by the hub in the same tick it is created, so runners can
// never claim it. The orchestrator sweep owns its terminal transition.
//
// ci-job: one executable job. Claimed only by runners that advertise the `ci`
// tag (RUNYARD_RUNNER_CI=1) and executed by the deterministic CI executor
// (src/runnerCi.js), never by `smithers up`.
export const CI_PIPELINE_CAPABILITY_SLUG = "ci-pipeline";
export const CI_JOB_CAPABILITY_SLUG = "ci-job";

// Tag a CI-enabled runner advertises; required by the ci-job capability.
export const CI_RUNNER_TAG = "ci";

// Tag reserved for hub-orchestrated runs. No runner may advertise it.
export const CI_HUB_TAG = "runyard-hub";

export function isCiPipelineRun(run) {
  return run?.capabilitySlug === CI_PIPELINE_CAPABILITY_SLUG;
}

export function isCiJobRun(run) {
  return run?.capabilitySlug === CI_JOB_CAPABILITY_SLUG;
}
