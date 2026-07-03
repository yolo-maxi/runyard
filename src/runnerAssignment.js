import {
  executionIntentFromInput,
  executionIntentMatchesRunnerTags
} from "./runExecution.js";
import { harnessSelectionSecretNames, resolveHarnessSelection } from "./runHarnessSelection.js";

function publicRunnerAvailability(runner) {
  return {
    id: runner.id,
    name: runner.name,
    tags: runner.tags,
    capacity: runner.capacity,
    workRuns: runner.workRuns,
    availableSlots: runner.availableSlots
  };
}

export function runnerMatchesAssignment(capability, runner, run) {
  if (!runner) return false;
  const tags = new Set(runner.tags || []);
  if (!(capability?.requiredRunnerTags || []).every((tag) => tags.has(tag))) return false;
  return executionIntentMatchesRunnerTags(executionIntentFromInput(run?.input || {}), runner.tags || []);
}

export function supportRunnerAvailabilityResult({ capability, runners = [] }) {
  if (!capability || !capability.enabled) {
    return { available: false, reason: "support capability is not installed", runners: [] };
  }
  const matchingRunners = runners.filter((runner) => runner.online && runnerMatchesAssignment(capability, runner, { input: {} }));
  if (!matchingRunners.length) {
    return {
      available: false,
      reason: `no online runner advertises required tags: ${(capability.requiredRunnerTags || []).join(", ") || "(none)"}`,
      runners: []
    };
  }
  return {
    available: true,
    reason: "",
    runners: matchingRunners.map(publicRunnerAvailability)
  };
}

export function secretNamesForRun(capability, runInput) {
  const fromCapability = Array.isArray(capability?.workflow?.secrets) ? capability.workflow.secrets : [];
  const fromInput = Array.isArray(runInput?.secretNames) ? runInput.secretNames : [];
  // A harness selection that names an endpoint key env (piApiKeyEnv) implies
  // delivery of that one secret — same trust as input.secretNames, which
  // already lets a run request any Hub secret by name.
  const fromSelection = harnessSelectionSecretNames(resolveHarnessSelection({ capability, input: runInput }).selection);
  return [
    ...new Set([...fromCapability, ...fromInput, ...fromSelection].map((name) => String(name || "").trim()).filter(Boolean))
  ];
}
