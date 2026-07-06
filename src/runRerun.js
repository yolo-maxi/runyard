import { createHash } from "node:crypto";
import { stableJsonString } from "./workflowEndpointSubmission.js";

export const ACTIVE_RERUN_STATUSES = new Set(["queued", "assigned", "running", "waiting_approval"]);

export function rerunFingerprint(input) {
  return createHash("sha256").update(stableJsonString(input || {})).digest("hex");
}

export function logicalRerunInput(run) {
  const rawInput = run?.input && typeof run.input === "object" && !Array.isArray(run.input) ? run.input : {};
  const clean = { ...rawInput };
  delete clean.__origin;
  return {
    capabilitySlug: run?.capabilitySlug,
    input: clean,
    isSupervisor: false
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

  return candidates[0]?.run || null;
}

export function cleanRerunInput(input, previousRunId) {
  const clean = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  delete clean.__origin;
  clean.rerunOf = previousRunId;
  return clean;
}
