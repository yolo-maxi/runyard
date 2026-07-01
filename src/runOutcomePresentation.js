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

// Different workflows report changed files under different keys; treat the
// unambiguous ones (changedFiles / filesChanged) as equivalent so the Runs UI
// reflects the real count instead of showing zero for workflows that don't
// emit `commit.files` (e.g. implement, workflow-doctor, idea-to-product).
// A bare `files` array is only trusted on the `commit` node — elsewhere it's
// too generic (a directory-listing node also uses `files`) to be a signal.
const GENERIC_CHANGED_FILE_KEYS = ["changedFiles", "filesChanged"];

function addFiles(list, seen, order) {
  for (const file of cleanStringList(list)) {
    if (!seen.has(file)) {
      seen.add(file);
      order.push(file);
    }
  }
}

function collectFromNode(node, seen, order) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  for (const key of GENERIC_CHANGED_FILE_KEYS) addFiles(node[key], seen, order);
}

// Union of the changed-file entries the workflow reported — checks the
// terminal envelope (`changedFiles` / `filesChanged`), the conventional
// `commit.files` array, and every per-node output's `changedFiles` /
// `filesChanged`. Preserves first-seen order so tests remain deterministic.
export function collectChangedFiles(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const seen = new Set();
  const order = [];
  collectFromNode(output, seen, order);
  const commit = outputNode(output, "commit");
  addFiles(commit?.files, seen, order);
  const nodes = output.outputs && typeof output.outputs === "object" && !Array.isArray(output.outputs)
    ? output.outputs
    : output;
  if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
    for (const value of Object.values(nodes)) collectFromNode(value, seen, order);
  }
  return order;
}

export function runOutcomeSummary(run) {
  const output = run?.output && typeof run.output === "object" && !Array.isArray(run.output) ? run.output : null;
  const baseline = outputNode(output, "baseline");
  const review = outputNode(output, "review");
  const files = collectChangedFiles(output);
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
