export function outputNode(output, name) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const nodes = output.outputs && typeof output.outputs === "object" && !Array.isArray(output.outputs)
    ? output.outputs
    : output;
  const node = nodes?.[name];
  return node && typeof node === "object" && !Array.isArray(node) ? node : null;
}

function outputNodesObject(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  return output.outputs && typeof output.outputs === "object" && !Array.isArray(output.outputs)
    ? output.outputs
    : output;
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
  const nodes = outputNodesObject(output);
  if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
    for (const value of Object.values(nodes)) collectFromNode(value, seen, order);
  }
  return order;
}

// Parse the trailing summary line of `git diff --shortstat` / `git diff --stat`
// output — GitHub-style +additions/-deletions come from that final line, which
// looks like " N files changed, X insertions(+), Y deletions(-)". Individual
// per-file lines (e.g. " src/foo.js | 5 +++--") also encode churn, but the
// footer is the canonical total the workflow already computed, so we prefer it
// and fall back to summing the per-file counts only when the footer is absent.
export function parseGitDiffStat(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let insertions = 0;
  let deletions = 0;
  let hadFooter = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    // Footer example: "3 files changed, 8 insertions(+), 12 deletions(-)"
    if (/\bfiles?\s+changed\b/i.test(line) && /(insertion|deletion)/i.test(line)) {
      const insMatch = line.match(/(\d+)\s+insertion/i);
      const delMatch = line.match(/(\d+)\s+deletion/i);
      if (insMatch) insertions = Number(insMatch[1]);
      if (delMatch) deletions = Number(delMatch[1]);
      hadFooter = true;
      break;
    }
  }
  if (!hadFooter) {
    for (const line of lines) {
      // Per-file example: " src/foo.js | 5 +++-- "
      const m = line.match(/\|\s*\d+\s+([+\-]+)\s*$/);
      if (!m) continue;
      const marks = m[1];
      for (const ch of marks) {
        if (ch === "+") insertions += 1;
        else if (ch === "-") deletions += 1;
      }
    }
  }
  if (!insertions && !deletions) return null;
  return { additions: insertions, deletions };
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeChurn(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const addRaw = candidate.additions ?? candidate.insertions ?? candidate.added ?? candidate.linesAdded;
  const delRaw = candidate.deletions ?? candidate.removed ?? candidate.linesDeleted ?? candidate.linesRemoved;
  const additions = typeof addRaw === "number" ? addRaw : Number(addRaw);
  const deletions = typeof delRaw === "number" ? delRaw : Number(delRaw);
  if (!isFiniteNonNegative(additions) || !isFiniteNonNegative(deletions)) return null;
  if (additions === 0 && deletions === 0) return null;
  return { additions, deletions };
}

// GitHub-style +added/-deleted line churn. Union across the terminal envelope
// (`churn`, `changeSummary`, `codeChurn`), the `commit.stat` text emitted by the
// gated implement/improve workflows, and any per-node churn payload workflows
// choose to surface. Returns null when nothing quantitative is available so old
// runs stay graceful.
export function collectCodeChurn(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const direct = normalizeChurn(output.churn) || normalizeChurn(output.codeChurn) || normalizeChurn(output.changeSummary);
  if (direct) return direct;
  const commit = outputNode(output, "commit");
  if (commit) {
    const commitChurn = normalizeChurn(commit.churn) || normalizeChurn(commit.codeChurn);
    if (commitChurn) return commitChurn;
    const parsed = parseGitDiffStat(commit.stat || commit.diffStat || commit.numstat || "");
    if (parsed) return parsed;
  }
  const nodes = outputNodesObject(output);
  if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
    for (const value of Object.values(nodes)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const nodeChurn = normalizeChurn(value.churn) || normalizeChurn(value.codeChurn);
      if (nodeChurn) return nodeChurn;
      const parsed = parseGitDiffStat(value.stat || value.diffStat || "");
      if (parsed) return parsed;
    }
  }
  return null;
}

function truncateSentence(raw, max = 240) {
  const value = String(raw || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  return value.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

// Extract the first sentence of a user-provided text (implement.summary,
// review.summary, deploy.verify), then truncate. File extensions inside the
// sentence (e.g. "src/foo.js") aren't valid sentence boundaries, so we only
// split on end punctuation followed by whitespace AND a capital letter or
// digit — the conservative heuristic keeps "we updated a.js and b.js." intact.
function firstSentence(raw, max = 200) {
  const value = String(raw || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const match = value.match(/^(.*?[.!?])\s+(?=[A-Z0-9])/);
  const first = match ? match[1] : value;
  return truncateSentence(first, max);
}

function joinFileList(files) {
  if (!files.length) return "";
  if (files.length === 1) return files[0];
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  if (files.length === 3) return `${files[0]}, ${files[1]}, and ${files[2]}`;
  return `${files[0]}, ${files[1]}, ${files[2]}, and ${files.length - 3} more`;
}

// One-sentence human digest of what the run produced. Preference order:
//   1. an explicit digest / summary field on the terminal envelope,
//   2. the `implement.summary` node the gated workflows already emit,
//   3. the `review.summary` when a workflow ran review-only,
//   4. a fallback built from the changed-file list.
// A `verify` hint from the deploy step (or any node that surfaces a
// verification note) is grafted on so the operator sees what still needs
// manual verification — e.g. "In this run, we updated X, Y, Z; deploy needs
// manual verification".
export function runOutcomeDigest(output, files = []) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return "";
  const explicit = firstSentence(output.digest || output.summary || "");
  const implement = outputNode(output, "implement");
  const implementSummary = firstSentence(implement?.summary || "");
  const review = outputNode(output, "review");
  const reviewSummary = firstSentence(review?.summary || "");
  const deploy = outputNode(output, "deploy");
  const deployVerify = firstSentence(deploy?.verify || "");
  const verifyHints = [];
  const nodes = outputNodesObject(output);
  if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
    for (const [name, value] of Object.entries(nodes)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (name === "deploy") continue;
      const hint = firstSentence(value.verify || value.manualVerify || value.needsVerification || "");
      if (hint) verifyHints.push(`${name}: ${hint}`);
    }
  }
  let base = explicit || implementSummary || reviewSummary;
  if (!base) {
    if (files.length) base = `In this run, we updated ${joinFileList(files)}.`;
    else if (deployVerify) base = "In this run, we ran the workflow.";
    else return "";
  }
  const base_ = base.replace(/[.!?]+$/, "");
  const tail = deployVerify
    ? `${deployVerify.replace(/[.!?]+$/, "")} needs manual verification`
    : verifyHints.length
      ? `${verifyHints[0].replace(/[.!?]+$/, "")} needs manual verification`
      : "";
  const sentence = tail ? `${base_}; ${tail}.` : `${base_}.`;
  return truncateSentence(sentence, 240);
}

export function runOutcomeSummary(run) {
  const output = run?.output && typeof run.output === "object" && !Array.isArray(run.output) ? run.output : null;
  const baseline = outputNode(output, "baseline");
  const review = outputNode(output, "review");
  const files = collectChangedFiles(output);
  const churn = collectCodeChurn(output);
  const noChangeRationale = hasNoChangeReviewRationale(review);
  let workProduct = "none";
  if (files.length) workProduct = `${files.length} changed file${files.length === 1 ? "" : "s"}`;
  else if (noChangeRationale) workProduct = "explicit no-change review";
  else if (output) workProduct = "output only";
  const digest = runOutcomeDigest(output, files);
  return {
    repo: String(baseline?.repoDir || run?.project || "").trim() || "unresolved",
    changedFiles: files.length,
    files,
    churn,
    digest,
    workProduct,
    classification: run?.status || "unknown"
  };
}
