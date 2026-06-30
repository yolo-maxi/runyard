import { createHash } from "node:crypto";
import { stableJsonString } from "./workflowEndpointSubmission.js";
import { SUPERVISOR_CAPABILITY_SLUG, stripSupervisionInternals } from "./supervision.js";

export const ACTIVE_RERUN_STATUSES = new Set(["queued", "assigned", "running", "waiting_approval"]);

export function rerunFingerprint(input) {
  return createHash("sha256").update(stableJsonString(input || {})).digest("hex");
}

export function logicalRerunInput(run) {
  const rawInput = run?.input && typeof run.input === "object" && !Array.isArray(run.input) ? run.input : {};
  const isSupervisor = run?.capabilitySlug === SUPERVISOR_CAPABILITY_SLUG
    && typeof rawInput.__supervisionToken === "string"
    && typeof rawInput.wrappedCapability === "string";
  const logicalInput = isSupervisor && rawInput.wrappedInput && typeof rawInput.wrappedInput === "object" && !Array.isArray(rawInput.wrappedInput)
    ? rawInput.wrappedInput
    : rawInput;
  const stripped = stripSupervisionInternals(logicalInput || {});
  const clean = stripped && typeof stripped === "object" && !Array.isArray(stripped) ? { ...stripped } : {};
  delete clean.__origin;
  return {
    capabilitySlug: isSupervisor ? rawInput.wrappedCapability : run?.capabilitySlug,
    input: clean,
    isSupervisor
  };
}

export function findActiveDuplicateRerun(runs = [], { previousRunId, capabilitySlug, input }) {
  const expectedFingerprint = rerunFingerprint(input);
  const candidates = (runs || [])
    .filter((run) => ACTIVE_RERUN_STATUSES.has(run.status))
    .map((run) => ({ run, logical: logicalRerunInput(run) }))
    .filter(({ logical }) => logical.capabilitySlug === capabilitySlug)
    .filter(({ logical }) => logical.input?.rerunOf === previousRunId)
    .filter(({ logical }) => rerunFingerprint(logical.input) === expectedFingerprint);

  return candidates.find(({ logical }) => logical.isSupervisor)?.run || candidates[0]?.run || null;
}

export function cleanRerunInput(input, previousRunId) {
  const clean = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  delete clean.__origin;
  delete clean.__supervisionToken;
  delete clean.__supervisedChild;
  clean.rerunOf = previousRunId;
  return clean;
}
