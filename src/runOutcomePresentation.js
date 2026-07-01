export function outputNode(output, name) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const nodes = output.outputs && typeof output.outputs === "object" && !Array.isArray(output.outputs)
    ? output.outputs
    : output;
  const node = nodes?.[name];
  return node && typeof node === "object" && !Array.isArray(node) ? node : null;
}

export function cleanStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

export function hasNoChangeReviewRationale(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return false;
  if (cleanStringList(review.improvements).length) return false;
  return Boolean(
    String(review.summary || "").trim()
    || cleanStringList(review.risks).length
    || cleanStringList(review.userPain).length
  );
}

export function runOutcomeSummary(run) {
  const output = run?.output && typeof run.output === "object" && !Array.isArray(run.output) ? run.output : null;
  const baseline = outputNode(output, "baseline");
  const commit = outputNode(output, "commit");
  const review = outputNode(output, "review");
  const files = cleanStringList(commit?.files);
  const noChangeRationale = hasNoChangeReviewRationale(review);
  let workProduct = "none";
  if (files.length) workProduct = `${files.length} changed file${files.length === 1 ? "" : "s"}`;
  else if (noChangeRationale) workProduct = "explicit no-change review";
  else if (output) workProduct = "output only";
  return {
    repo: String(baseline?.repoDir || run?.project || "").trim() || "unresolved",
    changedFiles: files.length,
    files,
    workProduct,
    classification: run?.status || "unknown"
  };
}
