import { runClaimAssignmentQuery } from "./runRecords.js";
import {
  runnerMatchesAssignment,
  secretNamesForRun
} from "./runnerAssignment.js";
import { workflowBundleReference } from "./workflowSource.js";

export function createRunClaimStore({
  run,
  now,
  getRunner,
  runnerLoad,
  listRuns,
  getCapability,
  adjustRunnerActiveRuns,
  addRunEvent,
  getRun,
  getDecryptedSecretEnv,
  buildAgentRuntimePack,
  getWorkflowBundle
}) {
  function claimNextRun(runnerId) {
    const runner = getRunner(runnerId);
    if (!runner || !runner.online) return null;

    const load = runnerLoad(runnerId);
    if (load.work >= runner.capacity) return null;

    for (const candidate of listRuns({ status: "queued", limit: 200, includeInternal: true })) {
      if (candidate.runnerId && candidate.runnerId !== runnerId) continue;

      const capability = getCapability(candidate.capabilitySlug);
      if (!runnerMatchesAssignment(capability, runner, candidate)) continue;
      if (load.work >= runner.capacity) continue;

      const query = runClaimAssignmentQuery({ runId: candidate.id, runnerId, timestamp: now() });
      const result = run(query.sql, query.params);
      if (!result.changes) continue;

      adjustRunnerActiveRuns(runnerId, 1);
      addRunEvent(candidate.id, "run.assigned", `Assigned to ${runner.name}`, { runnerId });

      const claimedRun = getRun(candidate.id);
      const secretEnv = getDecryptedSecretEnv(secretNamesForRun(capability, claimedRun?.input));
      const agentRuntimePack = buildAgentRuntimePack(capability);
      addRunEvent(candidate.id, "run.agent_runtime_pack", "Captured agent/skill runtime pack", {
        schemaVersion: agentRuntimePack.schemaVersion,
        capturedAt: agentRuntimePack.capturedAt,
        agents: agentRuntimePack.agents.map((agent) => ({ slug: agent.slug, version: agent.version })),
        skills: agentRuntimePack.skills.map((skill) => ({ slug: skill.slug, version: skill.version })),
        missing: agentRuntimePack.missing
      });

      const payload = { run: claimedRun, capability, agentRuntimePack };

      // DB-backed workflow capabilities ship the bundle bytes with the claim so
      // the runner can materialize the source before Smithers launch. When the
      // configured bundle is gone the claim still proceeds WITHOUT bundle data —
      // the runner fails the run closed at preflight rather than falling back to
      // a checked-in template. Events carry metadata only, never bundle code.
      const bundleId = workflowBundleReference(capability);
      if (bundleId) {
        const bundle = typeof getWorkflowBundle === "function" ? getWorkflowBundle(bundleId, { includeCode: true }) : null;
        if (bundle && typeof bundle.code === "string") {
          payload.workflowBundle = bundle;
          addRunEvent(candidate.id, "run.workflow_bundle", `Attached workflow bundle ${bundle.id} v${bundle.version}`, {
            bundleId: bundle.id,
            version: bundle.version,
            sha256: bundle.sha256,
            sizeBytes: bundle.sizeBytes
          });
        } else {
          addRunEvent(
            candidate.id,
            "run.workflow_bundle_missing",
            `Workflow bundle ${bundleId} is configured for ${capability?.slug} but missing from the bundle store; runner will fail preflight`,
            { bundleId }
          );
        }
      }

      if (Object.keys(secretEnv).length) payload.secretEnv = secretEnv;
      load.work += 1;
      return payload;
    }

    return null;
  }

  return { claimNextRun };
}
