import { RUN_FAILURE_CLASSES } from "./runFailureClass.js";

export const DEFAULT_MAX_INLINE_INPUT_BYTES = 64 * 1024;

export function largeInputPayload(input, maxBytes = DEFAULT_MAX_INLINE_INPUT_BYTES) {
  const payload = JSON.stringify(input || {});
  if (Buffer.byteLength(payload, "utf8") <= maxBytes) return { inline: payload, stdin: "" };
  return { inline: "", stdin: payload };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function hasExplicitNoChangeRationale(review) {
  if (!isObject(review)) return false;
  const improvements = Array.isArray(review.improvements) ? review.improvements : [];
  if (improvements.length) return false;
  return Boolean(
    String(review.summary || "").trim()
    || (Array.isArray(review.risks) && review.risks.some((risk) => String(risk || "").trim()))
    || (Array.isArray(review.userPain) && review.userPain.some((line) => String(line || "").trim()))
  );
}

export function productiveOutcomeFailure(capability, outputs) {
  if (!isObject(outputs) || !Object.keys(outputs).length) {
    return {
      status: RUN_FAILURE_CLASSES.INVALID_OUTPUT,
      error: "invalid output: succeeded workflow produced no node outputs"
    };
  }
  if (capability?.slug !== "improve") return null;
  const baseline = outputs.baseline;
  const baselineRepoDir = baseline?.repoDir || baseline?.repo_dir;
  if (!isObject(baseline) || !String(baselineRepoDir || "").trim()) {
    return {
      status: RUN_FAILURE_CLASSES.BLOCKED_BY_PREFLIGHT,
      error: "preflight failed: improve completed without a resolved target repo"
    };
  }
  const commit = outputs.commit;
  const files = Array.isArray(commit?.files) ? commit.files.filter((file) => String(file || "").trim()) : [];
  if (files.length) return null;
  if (hasExplicitNoChangeRationale(outputs.review)) return null;
  return {
    status: RUN_FAILURE_CLASSES.INVALID_OUTPUT,
    error: "invalid output: improve succeeded without changed files or an explicit no-change rationale"
  };
}
