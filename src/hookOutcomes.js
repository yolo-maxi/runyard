// Post-run hook outcome vocabulary. Hooks are optional side effects that run
// after a build/check run has produced its verified artifacts (static publish,
// git push, webhook, ...). Their outcomes are deliberately NOT run statuses:
// a failed hook never rewrites a green build into a generic failed run. The
// run keeps its own status; hook results ride in the run output and are
// summarized separately.
export const HOOK_STATUS_SUCCEEDED = "succeeded";
export const HOOK_STATUS_FAILED = "hook_failed";
export const HOOK_STATUS_CONFIG_REQUIRED = "hook_config_required";
export const HOOK_STATUS_BLOCKED = "hook_blocked";
export const HOOK_STATUS_SKIPPED = "skipped";

export const HOOK_OUTCOME_STATUSES = Object.freeze([
  HOOK_STATUS_SUCCEEDED,
  HOOK_STATUS_FAILED,
  HOOK_STATUS_CONFIG_REQUIRED,
  HOOK_STATUS_BLOCKED,
  HOOK_STATUS_SKIPPED
]);

// Severity order for aggregating per-hook results into one headline status.
const AGGREGATE_PRECEDENCE = [
  HOOK_STATUS_FAILED,
  HOOK_STATUS_CONFIG_REQUIRED,
  HOOK_STATUS_BLOCKED,
  HOOK_STATUS_SUCCEEDED,
  HOOK_STATUS_SKIPPED
];

export function isHookOutcomeStatus(value) {
  return HOOK_OUTCOME_STATUSES.includes(String(value || ""));
}

export function aggregateHookStatus(results = []) {
  const statuses = results.map((entry) => String(entry?.status || "")).filter(isHookOutcomeStatus);
  if (!statuses.length) return HOOK_STATUS_SKIPPED;
  for (const status of AGGREGATE_PRECEDENCE) {
    if (statuses.includes(status)) return status;
  }
  return HOOK_STATUS_SKIPPED;
}

function normalizeHookResult(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const status = String(entry.status || "");
  if (!isHookOutcomeStatus(status)) return null;
  return {
    profile: String(entry.profile || ""),
    status,
    detail: String(entry.detail || "")
  };
}

function nodeCandidates(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return {};
  return output.outputs && typeof output.outputs === "object" && !Array.isArray(output.outputs)
    ? output.outputs
    : output;
}

// Extract the post-run hook outcomes a workflow reported. The canonical shape
// is a `hooks` node ({status, results:[{profile,status,detail}]}); legacy
// gated workflows report a hook-style status on their old `deploy` node while
// the input is deprecated. Returns null when the run predates hooks so old
// runs stay untouched.
export function collectHookOutcomes(output) {
  const nodes = nodeCandidates(output);
  const hooksNode = nodes.hooks && typeof nodes.hooks === "object" && !Array.isArray(nodes.hooks) ? nodes.hooks : null;
  if (hooksNode) {
    const results = Array.isArray(hooksNode.results)
      ? hooksNode.results.map(normalizeHookResult).filter(Boolean)
      : [];
    const status = isHookOutcomeStatus(hooksNode.status) ? String(hooksNode.status) : aggregateHookStatus(results);
    return { status, results };
  }
  const deployNode = nodes.deploy && typeof nodes.deploy === "object" && !Array.isArray(nodes.deploy) ? nodes.deploy : null;
  if (deployNode && isHookOutcomeStatus(deployNode.status)) {
    const status = String(deployNode.status);
    return {
      status,
      results: [{ profile: "legacy:deploy", status, detail: String(deployNode.verify || "") }]
    };
  }
  return null;
}
