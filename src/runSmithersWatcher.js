// Public facade for pure run-smithers watcher helpers. Keep this import surface
// stable for workflow templates and tests while the implementation is split by
// concern: classification, state, decision policy, and final success gating.

export {
  classifyChildState,
  classifyFailureClass,
  classifyWorkflowCodeFailure,
  normalizeErrorFingerprint
} from "./runSmithersClassification.js";
export {
  RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS,
  RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS,
  RUN_SMITHERS_FINGERPRINT_LIMIT,
  RUN_SMITHERS_LINEAGE_SCHEMA_VERSION
} from "./runSmithersPolicy.js";
export {
  createWatcherState,
  recordChildAttempt,
  recordRepairAttempt,
  watcherSummary
} from "./runSmithersState.js";
export { decideNextAction } from "./runSmithersDecision.js";
export { assertSupervisionSucceeded } from "./runSmithersGate.js";
