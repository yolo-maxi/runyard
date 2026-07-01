import { SUPERVISOR_CAPABILITY_SLUG } from "./supervision.js";
import { runClaimAssignmentQuery } from "./runRecords.js";
import {
  runnerMatchesAssignment,
  secretNamesForRun
} from "./runnerAssignment.js";

export function createRunClaimStore({
  run,
  now,
  getRunner,
  supervisorPoolSize,
  runnerLoad,
  listRuns,
  getCapability,
  adjustRunnerActiveRuns,
  addRunEvent,
  getRun,
  getDecryptedSecretEnv,
  buildAgentRuntimePack,
  supervisorCapabilitySlug = SUPERVISOR_CAPABILITY_SLUG
}) {
  function claimNextRun(runnerId) {
    const runner = getRunner(runnerId);
    if (!runner || !runner.online) return null;

    const supervisorCapacity = supervisorPoolSize(runner.capacity);
    const load = runnerLoad(runnerId);
    if (load.work >= runner.capacity && load.supervisors >= supervisorCapacity) return null;

    for (const candidate of listRuns({ status: "queued", limit: 200, includeInternal: true })) {
      if (candidate.runnerId && candidate.runnerId !== runnerId) continue;

      const capability = getCapability(candidate.capabilitySlug);
      if (!runnerMatchesAssignment(capability, runner, candidate)) continue;

      const isSupervisor = candidate.capabilitySlug === supervisorCapabilitySlug;
      if (isSupervisor) {
        if (load.supervisors >= supervisorCapacity) continue;
      } else if (load.work >= runner.capacity) {
        continue;
      }

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
      if (Object.keys(secretEnv).length) payload.secretEnv = secretEnv;
      return payload;
    }

    return null;
  }

  return { claimNextRun };
}
