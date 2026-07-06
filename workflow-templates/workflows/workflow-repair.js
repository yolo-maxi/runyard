// Pure-ish helper for workflow repair: map a capability's workflow entry to its
// repo source file and its runner-workspace copy, and sync a repaired template
// from the repo into the workspace so the rerun actually executes the fix.
//
// The Hub ships workflow templates from `workflow-templates/workflows/<file>`
// and `smithers-hub runner init` copies them into `<workspace>/.smithers/
// workflows/<file>`. A capability's `workflow.entry` is the workspace-relative
// path (e.g. `.smithers/workflows/product-workflow.tsx`). After a repair agent
// edits the repo copy, `syncWorkflowToWorkspace` mirrors that one file into the
// workspace — the same one-file overwrite `runner init` does, never a broad or
// destructive operation.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const WORKFLOW_FILE_RE = /^[a-zA-Z0-9_.-]+\.(?:tsx|ts|jsx|js)$/;
export const REPO_WORKFLOWS_SUBDIR = path.join("workflow-templates", "workflows");
export const WORKSPACE_WORKFLOWS_SUBDIR = path.join(".smithers", "workflows");

// Extract the bare, safe workflow filename from a capability entry / slug.
// Returns "" for anything that isn't a single, traversal-free workflow file.
export function workflowFileFromEntry(entry, slug = "") {
  const raw = String(entry || "").trim();
  let file = raw ? path.basename(raw) : "";
  if (!file && slug) file = `${String(slug).trim()}.tsx`;
  if (!file) return "";
  if (file.includes("..") || file.includes("/") || file.includes("\\")) return "";
  if (!WORKFLOW_FILE_RE.test(file)) return "";
  return file;
}

export function repoWorkflowSourcePath(repoRoot, file) {
  return path.join(repoRoot, REPO_WORKFLOWS_SUBDIR, file);
}

export function workspaceWorkflowPath(workspaceDir, file) {
  return path.join(workspaceDir, WORKSPACE_WORKFLOWS_SUBDIR, file);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Copy the repaired workflow template from the repo into the runner workspace.
// Returns { ok, file, from, to, bytes, error }. Never throws — callers branch
// on `ok` so a sync failure can be surfaced cleanly.
export function syncWorkflowToWorkspace({ repoRoot, workspaceDir, entry, slug = "" } = {}) {
  const file = workflowFileFromEntry(entry, slug);
  if (!file) return { ok: false, error: `unrecognised workflow entry: ${entry || slug}` };
  if (!repoRoot || !workspaceDir) return { ok: false, file, error: "repoRoot and workspaceDir are required" };

  const repoRootAbs = path.resolve(repoRoot);
  const workspaceAbs = path.resolve(workspaceDir);
  const from = repoWorkflowSourcePath(repoRootAbs, file);
  const to = workspaceWorkflowPath(workspaceAbs, file);

  // Guardrails: both paths must stay within their declared roots, and the
  // source must be a real file. No deletes, no traversal, single file only.
  if (!isInside(path.join(repoRootAbs, REPO_WORKFLOWS_SUBDIR), from)) {
    return { ok: false, file, from, to, error: "resolved source escapes the repo workflows dir" };
  }
  if (!isInside(path.join(workspaceAbs, WORKSPACE_WORKFLOWS_SUBDIR), to)) {
    return { ok: false, file, from, to, error: "resolved target escapes the workspace workflows dir" };
  }
  if (!existsSync(from)) return { ok: false, file, from, to, error: `repaired source not found: ${from}` };

  try {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    const bytes = statSync(to).size;
    return { ok: true, file, from, to, bytes };
  } catch (error) {
    return { ok: false, file, from, to, error: String(error?.message || error) };
  }
}
