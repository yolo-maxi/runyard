// Public facade for Hub-as-Supervisor helpers. The implementation is split by
// concern so the DB reaper can depend on a small stable surface while decision
// policy and repair/escalation payload shaping stay independently testable.

export {
  classifyConfigFailure,
  classifyWorkflowCodeFailure,
  decideReconcile,
  HUB_DEFAULT_CAPS,
  HUB_DEFAULT_MAX_RESUMES_PER_FINGERPRINT,
  HUB_SUPERVISOR_DECISION_SCHEMA,
  normalizeErrorFingerprint
} from "./hubSupervisorDecision.js";
export {
  buildEscalationApproval,
  buildHubRepairInput
} from "./hubSupervisorRepair.js";
