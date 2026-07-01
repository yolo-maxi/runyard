import { deepLinks } from "./deepLinks.js";
import { buildHubRepairInput } from "./hubSupervisor.js";
import {
  SUPERVISOR_CAPABILITY_SLUG,
  buildSupervisorInput,
  decideSupervision,
  mintSupervisionToken,
  stripSupervisionInternals
} from "./supervision.js";

// Create a dispatcher that turns a run request into the correct stored run.
// The policy lives in supervision.js; this module wires that policy to DB/event
// side effects so HTTP routes, schedules, and reruns all share one path.
export function createRunDispatcher({
  addRunEvent,
  createRun,
  findActiveSupervisorByToken,
  getCapability,
  mintToken = mintSupervisionToken
} = {}) {
  return function dispatchRun(capability, input, options = {}) {
    const decision = decideSupervision(capability, input, {
      findSupervisorByToken: findActiveSupervisorByToken
    });

    if (decision.action === "wrap") {
      const supervisorCapability = getCapability(SUPERVISOR_CAPABILITY_SLUG);
      if (supervisorCapability && supervisorCapability.enabled) {
        return createSupervisedRun({
          addRunEvent,
          capability,
          createRun,
          input,
          mintToken,
          options,
          supervisorCapability
        });
      }
      // Supervisor capability missing/disabled: run directly rather than
      // blocking the user entirely.
    }

    if (decision.parentRunId) {
      return createSupervisedChildRun({
        addRunEvent,
        capability,
        createRun,
        decision,
        input,
        options
      });
    }

    return { run: createRun(capability, input, options) };
  };
}

function createSupervisedRun({ addRunEvent, capability, createRun, input, mintToken, options, supervisorCapability }) {
  const token = mintToken();
  const goal = typeof input?.goal === "string" && input.goal.trim() ? input.goal.trim() : "";
  const supervisorInput = buildSupervisorInput({ capability, input, goal, token });
  const run = createRun(supervisorCapability, supervisorInput, {
    ...options,
    origin: { ...(options.origin || {}), supervises: capability.slug, wrappedCapability: capability.slug }
  });
  addRunEvent(run.id, "run.supervision.wrapped", `Supervising ${capability.name} via run-smithers`, {
    wrappedCapability: capability.slug,
    wrappedCapabilityName: capability.name
  });
  return {
    run,
    supervising: {
      supervisor: SUPERVISOR_CAPABILITY_SLUG,
      wrappedCapability: capability.slug,
      wrappedCapabilityName: capability.name
    }
  };
}

function createSupervisedChildRun({ addRunEvent, capability, createRun, decision, input, options }) {
  const childInput = stripSupervisionInternals(input);
  const origin = {
    ...(options.origin || {}),
    type: "run-smithers-child",
    parentRunId: decision.parentRunId,
    label: (options.origin && options.origin.label) || `Supervised child of ${decision.parentRunId}`
  };
  const run = createRun(capability, childInput, { ...options, origin });
  addRunEvent(run.id, "run.supervision.child", `Supervised child run of ${decision.parentRunId}`, {
    parentRunId: decision.parentRunId,
    deepLink: deepLinks.run(decision.parentRunId)
  });
  addRunEvent(decision.parentRunId, "run.supervision.spawned_child", `Spawned supervised child run ${run.id}`, {
    childRunId: run.id,
    capability: capability.slug,
    deepLink: deepLinks.run(run.id)
  });
  return { run, supervisedChild: { parentRunId: decision.parentRunId } };
}

export function createHubRepairDispatcher({
  addRunEvent,
  createRun,
  getCapability,
  logError = console.error,
  repairBranch = process.env.RUN_SMITHERS_REPAIR_BRANCH || "smithers-self-repair"
} = {}) {
  return function dispatchHubRepair(failedRun, decision) {
    try {
      const capability = getCapability("implement-change-gated");
      if (!capability || !capability.enabled) return "";
      const wrapped = getCapability(failedRun.capabilitySlug);
      const repairInput = buildHubRepairInput(failedRun, decision, {
        wrappedEntry: wrapped?.workflow?.entry || "",
        repairBranch
      });
      const createOptions = {
        requestedBy: "system:hub-supervisor",
        origin: { type: "hub-supervisor-repair", repairsRunId: failedRun.id, fingerprint: decision.fingerprint || "" }
      };
      if (!repairInput.__execution?.runnerLocation && failedRun.runnerId) {
        createOptions.runnerId = failedRun.runnerId;
      }
      const run = createRun(capability, repairInput, createOptions);
      addRunEvent(failedRun.id, "run.supervisor.repair_child", `Hub dispatched code repair run ${run.id}`, {
        repairRunId: run.id,
        fingerprint: decision.fingerprint || "",
        targetBranch: repairInput.targetBranch,
        runnerLocation: repairInput.__execution?.runnerLocation || "",
        runnerId: createOptions.runnerId || ""
      });
      return run?.id || "";
    } catch (error) {
      logError("hub repair dispatch failed:", error.message);
      return "";
    }
  };
}
