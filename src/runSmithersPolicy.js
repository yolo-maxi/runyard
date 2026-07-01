export const RUN_SMITHERS_FINGERPRINT_LIMIT = 3;
export const RUN_SMITHERS_DEFAULT_MAX_ATTEMPTS = 8;
// One bounded workflow-code repair per supervised child by default. If the
// same class of failure repeats after repair, supervision escalates instead of
// looping.
export const RUN_SMITHERS_DEFAULT_MAX_CODE_REPAIRS = 1;
export const RUN_SMITHERS_LINEAGE_SCHEMA_VERSION = "smithers.hub.run-smithers.watcher.v1";
